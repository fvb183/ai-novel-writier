/** Desktop implementation of the documented AndroidBridge protocol for backend E2E tests.
 * Uses Node's real filesystem, OpenSSL and built-in SQLite, never stubbed repositories.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export function createNativeMock(baseDir, { virtualPaths = false, configureSqliteOpen, allowHardLinks = false } = {}) {
  const hostFiles = path.resolve(baseDir, 'files'), hostCache = path.resolve(baseDir, 'cache')
  const filesDir = virtualPaths ? '/android/files' : hostFiles
  const cacheDir = virtualPaths ? '/android/cache' : hostCache
  fs.mkdirSync(hostFiles, { recursive: true }); fs.mkdirSync(hostCache, { recursive: true })
  const databases = new Map(), descriptors = new Set(), preparedWrites = new Map()
  const hashes = new Map()
  let nextDatabase = 1
  let sqliteOpenAttempts = 0, sqliteClosedHandles = 0, verifiedDescriptors = 0
  const directoryDescriptors = new Map()
  let nextDirectoryDescriptor = -10
  const environment = { filesDir, cacheDir, version: '1.3.0', platform: 'android' }
  function virtualPath(target) {
    if (!virtualPaths) return target
    for (const [source, destination] of [[hostFiles, filesDir], [hostCache, cacheDir]]) {
      const relative = path.relative(source, target)
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) return path.posix.join(destination, ...relative.split(path.sep))
    }
    throw Object.assign(new Error('Resolved path outside private storage'), { code: 'EACCES' })
  }
  function allowed(target) {
    if (typeof target === 'number') { if (!descriptors.has(target) && !directoryDescriptors.has(target)) throw Object.assign(new Error('Bad file descriptor'), { code: 'EBADF' }); return directoryDescriptors.get(target) ?? target }
    if (target === ':memory:' || target === '') return target
    const platformPath = virtualPaths ? path.posix : path
    const resolved = platformPath.resolve(target)
    for (const [source, destination] of [[filesDir, hostFiles], [cacheDir, hostCache]]) {
      if (resolved === source || resolved.startsWith(source + platformPath.sep)) {
        const result = virtualPaths ? path.join(destination, ...platformPath.relative(source, resolved).split('/')) : resolved
        let cursor = destination
        for (const part of path.relative(destination, result).split(path.sep).filter(Boolean)) {
          cursor = path.join(cursor, part)
          try { if (fs.lstatSync(cursor).isSymbolicLink()) throw Object.assign(new Error('Link outside private boundary'), { code: 'EACCES' }) }
          catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        return result
      }
    }
    throw Object.assign(new Error(`Path outside private storage: ${String(target)}`), { code: 'EACCES' })
  }
  function stats(target, lstat = false) {
    const resolved = allowed(target)
    const result = typeof resolved === 'number' ? fs.fstatSync(resolved, { bigint: true }) : fs[lstat ? 'lstatSync' : 'statSync'](resolved, { bigint: true })
    const value = { isFile: result.isFile(), isDirectory: result.isDirectory(), isSymbolicLink: result.isSymbolicLink() }
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'mtimeMs', 'ctimeMs', 'atimeMs', 'birthtimeMs']) value[key] = String(result[key])
    return value
  }
  function param(value) {
    if (value && typeof value === 'object' && '$blob' in value) return Buffer.from(value.$blob, 'base64')
    if (value && typeof value === 'object' && '$int64' in value) return BigInt(value.$int64)
    return value
  }
  function serial(value) {
    if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString('base64') }
    if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : { $int64: value.toString() }
    if (Array.isArray(value)) return value.map(serial)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serial(item)]))
    return value
  }
  function secureTarget(capability) {
    const root = allowed(capability.rootPath)
    const rootStat = fs.statSync(root, { bigint: true })
    if (String(rootStat.dev) !== String(capability.rootIdentity.volumeSerialNumber) || String(rootStat.ino) !== String(capability.rootIdentity.fileIndex)) throw new Error('SECURE_FS_INVALID_PATH')
    const segments = String(capability.relativePath).split(/[\\/]+/).filter(Boolean)
    if (segments.some(segment => segment === '..' || segment === '.' || segment.includes(':'))) throw new Error('SECURE_FS_INVALID_PATH')
    let target = root
    for (const segment of segments) { target = path.join(target, segment); if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('SECURE_FS_INVALID_PATH') }
    return target
  }
  function openDatabase(target, options) {
    if (options?.fileMustExist && !fs.existsSync(target)) throw Object.assign(new Error('Unable to open database file'), { code: 'SQLITE_CANTOPEN' })
    let database
    try {
      sqliteOpenAttempts++
      database = new DatabaseSync(target, { readOnly: Boolean(options?.readonly) })
      // Android opens with FK enforcement off and may write locale/journal
      // metadata during its own connection configuration, after byte admission.
      database.exec('PRAGMA foreign_keys = OFF')
      if (!options?.readonly) {
        database.exec('CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT)')
        if (!database.prepare('SELECT 1 FROM android_metadata').get()) database.prepare('INSERT INTO android_metadata(locale) VALUES(?)').run('en_US')
      }
      configureSqliteOpen?.(database, target, options)
      database.exec(`PRAGMA busy_timeout = ${Number(options?.timeout ?? 5000)}`)
      const id = nextDatabase++; databases.set(id, database); database = undefined
      return id
    } finally {
      if (database) { try { database.close() } catch { /* Preserve the configuration error. */ } finally { sqliteClosedHandles++ } }
    }
  }
  const changedSqliteSource = () => Object.assign(new Error('SOURCE_CHANGED_SINCE_PROBE'), { code: 'SOURCE_CHANGED_SINCE_PROBE' })
  function openVerifiedDatabase(targetPath, options, expected) {
    if (typeof targetPath !== 'string' || !targetPath || targetPath === ':memory:' || options?.fileMustExist !== true || options?.readonly
      || !expected || Array.isArray(expected) || Object.keys(expected).sort().join(',') !== 'database,wal'
      || typeof expected.database !== 'string' || typeof expected.wal !== 'string'
      || !/^[a-f0-9]{64}$/.test(expected.database) || !/^[a-f0-9]{64}$/.test(expected.wal)) {
      throw Object.assign(new Error('Invalid verified SQLite open'), { code: 'SQLITE_VERIFIED_OPEN_INVALID' })
    }
    if (targetPath.split(/[\\/]/).some(part => part === '.' || part === '..')) throw Object.assign(new Error('Unsafe SQLite path'), { code: 'EACCES' })
    const target = allowed(targetPath), held = [], absent = []
    const failUnsafe = () => { throw Object.assign(new Error('SQLite source and sidecars must be unlinked regular files'), { code: 'EACCES' }) }
    const same = (left, right) => right.isFile() && right.nlink === 1n
      && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key])
    const validateParent = () => {
      let cursor = path.dirname(target)
      while (true) {
        const info = fs.lstatSync(cursor)
        if (!info.isDirectory() || info.isSymbolicLink()) failUnsafe()
        if (cursor === hostFiles || cursor === hostCache) return
        const parent = path.dirname(cursor)
        if (parent === cursor) failUnsafe()
        cursor = parent
      }
    }
    const openSource = (file, required = false) => {
      let named
      try { named = fs.lstatSync(file, { bigint: true }) }
      catch (error) { if (!required && error.code === 'ENOENT') { absent.push(file); return null }; throw error }
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n) failUnsafe()
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); verifiedDescriptors++
      const record = { file, fd, info: null }; held.push(record)
      record.info = fs.fstatSync(fd, { bigint: true })
      if (!same(named, record.info)) throw changedSqliteSource()
      return record
    }
    const hash = record => {
      const digest = crypto.createHash('sha256'), chunk = Buffer.alloc(65536)
      if (record) { let count; while ((count = fs.readSync(record.fd, chunk, 0, chunk.length, null)) > 0) digest.update(chunk.subarray(0, count)) }
      return digest.digest('hex')
    }
    const closeHeld = () => {
      let failure
      for (const record of held) {
        if (record.closed) continue
        try { fs.closeSync(record.fd); record.closed = true; verifiedDescriptors-- }
        catch (error) { failure ??= error }
      }
      if (failure) throw failure
      held.length = 0
    }
    try {
      validateParent()
      const main = openSource(target, true), wal = openSource(target + '-wal')
      openSource(target + '-shm'); openSource(target + '-journal')
      if (hash(main) !== expected.database || hash(wal) !== expected.wal) throw changedSqliteSource()
      validateParent()
      for (const record of held) if (!same(record.info, fs.fstatSync(record.fd, { bigint: true })) || !same(record.info, fs.lstatSync(record.file, { bigint: true }))) throw changedSqliteSource()
      for (const file of absent) { try { fs.lstatSync(file); throw changedSqliteSource() } catch (error) { if (error.code !== 'ENOENT') throw error } }
      // Match Android's lifecycle: never close a raw verifier descriptor after
      // SQLite has acquired locks on that inode.
      closeHeld()
      return openDatabase(target, options)
    } finally {
      try { closeHeld() } catch { /* Preserve the admission error after best-effort cleanup. */ }
    }
  }
  function dispatch(op, args = []) {
    const [a, b, c, d, e, f] = args
    switch (op) {
      case 'env': return environment
      case 'fs.exists': return fs.existsSync(allowed(a))
      case 'fs.realpath': return virtualPath(fs.realpathSync(allowed(a)))
      case 'fs.stat': return stats(a, b?.lstat)
      case 'fs.readFile': return fs.readFileSync(allowed(a)).toString('base64')
      case 'fs.writeFile': fs.writeFileSync(allowed(a), Buffer.from(b, 'base64'), c); return null
      case 'fs.validateDirectoryChain': {
        const target = allowed(a)
        let cursor = target
        while (true) {
          try {
            const info = fs.lstatSync(cursor)
            if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error('Unsafe directory chain'), { code: 'EACCES' })
          } catch (error) { if (!(b?.allowMissing && error.code === 'ENOENT')) throw error }
          if (cursor === hostFiles || cursor === hostCache) break
          cursor = path.dirname(cursor)
        }
        return a
      }
      case 'fs.chmod': fs.chmodSync(allowed(a), b); return null
      // Ordinary Android apps cannot hard-link under SELinux. A host test must
      // opt into desktop behavior explicitly rather than silently admit it.
      case 'fs.link':
        if (!allowHardLinks) throw Object.assign(new Error('Android SELinux denies hard links'), { code: 'EPERM' })
        fs.linkSync(allowed(a), allowed(b)); return null
      case 'fs.installExclusive': {
        const source = allowed(a), target = allowed(b), before = fs.lstatSync(source, { bigint: true })
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw Object.assign(new Error('Unsafe install source'), { code: 'EACCES' })
        try { fs.lstatSync(target); throw Object.assign(new Error('Target exists'), { code: 'EEXIST' }) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        // This single synchronous dispatch models the native monitor and the
        // app-private ownership lock. No callbacks run in the check/move gap.
        const descriptor = fs.openSync(source, 'r+'); try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
        fs.renameSync(source, target)
        const after = fs.lstatSync(target, { bigint: true })
        if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1n) throw new Error('Install identity changed')
        return null
      }
      case 'fs.copyFile': fs.copyFileSync(allowed(a), allowed(b), c); return null
      case 'fs.write': return fs.writeSync(allowed(a), Buffer.from(b, 'base64'), 0, Buffer.from(b, 'base64').length, c)
      case 'fs.read': {
        const buffer = Buffer.alloc(c)
        const count = fs.readSync(allowed(a), buffer, 0, c, d)
        return buffer.subarray(0, count).toString('base64')
      }
      case 'fs.readdir': return fs.readdirSync(allowed(a), { withFileTypes: true }).map(entry => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() }))
      case 'fs.mkdir': return fs.mkdirSync(allowed(a), b) ?? null
      case 'fs.rename': fs.renameSync(allowed(a), allowed(b)); return null
      case 'fs.remove': {
        const target = allowed(a)
        if (b?.directoryOnly && !b?.recursive) fs.rmdirSync(target)
        else if (b?.fileOnly) fs.unlinkSync(target)
        else fs.rmSync(target, b)
        return null
      }
      case 'fs.open': {
        const target = allowed(a)
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          const descriptor = nextDirectoryDescriptor--; directoryDescriptors.set(descriptor, target); return descriptor
        }
        const descriptor = fs.openSync(target, b, c); descriptors.add(descriptor); return descriptor
      }
      case 'fs.close': if (directoryDescriptors.delete(a)) return null; fs.closeSync(allowed(a)); descriptors.delete(a); return null
      // The protocol harness cannot fsync Windows directories; Android uses Os.fsync.
      case 'fs.fsync': if (!directoryDescriptors.has(a)) fs.fsyncSync(allowed(a)); return null
      case 'fs.secureRead': {
        const target = secureTarget(a), info = fs.statSync(target)
        if (!info.isFile()) throw new Error('SECURE_FS_NOT_FILE')
        if (info.size > (a.maxBytes ?? 64 * 1024 * 1024)) throw new Error('SECURE_FS_TOO_LARGE')
        return fs.readFileSync(target).toString('base64')
      }
      case 'fs.securePrepare': {
        const target = secureTarget(a)
        if (a.mustAlreadyExist && !fs.existsSync(target)) throw new Error('SECURE_FS_NOT_FOUND')
        const token = crypto.randomUUID(), temporary = target + '.' + token + '.tmp'
        fs.writeFileSync(temporary, Buffer.from(a.contentBase64, 'base64'), { flag: 'wx', mode: 0o600 })
        preparedWrites.set(token, { target, temporary, capability: a })
        return { token }
      }
      case 'fs.secureCommit': {
        const record = preparedWrites.get(a); if (!record) throw new Error('SECURE_FS_INVALID_OPERATION')
        const target = secureTarget(record.capability)
        if (record.capability.mustAlreadyExist && !fs.existsSync(target)) throw new Error('SECURE_FS_NOT_FOUND')
        fs.renameSync(record.temporary, target); preparedWrites.delete(a); return null
      }
      case 'fs.secureCancel': {
        const record = preparedWrites.get(a); if (record) fs.rmSync(record.temporary, { force: true })
        preparedWrites.delete(a); return null
      }
      case 'sqlite.open': {
        const target = allowed(a)
        return openDatabase(target, b)
      }
      case 'sqlite.openVerified': return openVerifiedDatabase(a, b, c)
      case 'sqlite.close': if (databases.has(a)) { databases.get(a).close(); databases.delete(a); sqliteClosedHandles++ }; return null
      case 'sqlite.backup': {
        const database = databases.get(a)
        const target = allowed(b)
        database.prepare('VACUUM INTO ?').run(target)
        const copy = new DatabaseSync(target)
        try {
          if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid snapshot')
          return { totalPages: copy.prepare('PRAGMA page_count').get().page_count, remainingPages: 0 }
        } finally { copy.close() }
      }
      case 'sqlite.serialize': {
        const target = path.join(hostCache, `snapshot-${crypto.randomUUID()}.sqlite`)
        try {
          databases.get(a).prepare('VACUUM INTO ?').run(target)
          return fs.readFileSync(target).toString('base64')
        } finally { fs.rmSync(target, { force: true }) }
      }
      case 'sqlite.exec': databases.get(a).exec(b); return null
      case 'sqlite.schemaSnapshot': {
        const database = databases.get(a)
        const all = sql => serial(database.prepare(sql).all())
        const objects = all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='android_metadata' OR tbl_name='android_metadata'")
        return { schema: all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"), objects,
          columns: objects.length ? all('PRAGMA table_info(android_metadata)') : [], rows: objects.length ? all('SELECT locale FROM android_metadata') : [] }
      }
        case 'sqlite.query': {
          // Android 11's SQLite predates table_list (3.37). Exercise the minimum
          // supported platform instead of silently borrowing Node's newer SQL.
          if (/\bpragma_table_list\b/i.test(b)) throw Object.assign(new Error('no such table: pragma_table_list'), { code: 'SQLITE_ERROR' })
          const statement = databases.get(a).prepare(b); statement.setReadBigInts(true); return serial(statement.all(...c.map(param)))
        }
      case 'sqlite.run': { const statement = databases.get(a).prepare(b); return serial(statement.run(...c.map(param))) }
      case 'crypto.random': return crypto.randomBytes(a).toString('base64')
      case 'crypto.hash.create': {
        const id = crypto.randomUUID(); hashes.set(id, crypto.createHash(a)); return id
      }
      case 'crypto.hash.update': hashes.get(a).update(Buffer.from(b, 'base64')); return null
      case 'crypto.hash.digest': {
        const digest = hashes.get(a).digest('base64'); hashes.delete(a); return digest
      }
      case 'crypto.hash.copy': {
        const id = crypto.randomUUID(); hashes.set(id, hashes.get(a).copy()); return id
      }
      case 'crypto.hash': return crypto.createHash(a).update(Buffer.from(b, 'base64')).digest('base64')
      case 'crypto.hmac': return crypto.createHmac(a, Buffer.from(b, 'base64')).update(Buffer.from(c, 'base64')).digest('base64')
      case 'crypto.cipher': {
        const cipher = crypto.createCipheriv(a, Buffer.from(b, 'base64'), Buffer.from(c, 'base64'))
        if (e) cipher.setAAD(Buffer.from(e, 'base64'))
        const data = Buffer.concat([cipher.update(Buffer.from(d, 'base64')), cipher.final()])
        return { data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
      }
      case 'crypto.decipher': {
        const cipher = crypto.createDecipheriv(a, Buffer.from(b, 'base64'), Buffer.from(c, 'base64'))
        if (f) cipher.setAAD(Buffer.from(f, 'base64')); cipher.setAuthTag(Buffer.from(e, 'base64'))
        return Buffer.concat([cipher.update(Buffer.from(d, 'base64')), cipher.final()]).toString('base64')
      }
      default: throw Object.assign(new Error(`Unimplemented native mock operation: ${op}`), { code: 'ENOSYS' })
    }
  }
  function sync(json) {
    try { const { op, args } = JSON.parse(json); return JSON.stringify({ ok: true, value: dispatch(op, args) ?? null }) }
    catch (error) { return JSON.stringify({ ok: false, error: error.message, code: error.code || 'EIO' }) }
  }
  return {
    sync, dispatch, environment, hostPath: allowed,
    sqliteState() { return { openAttempts: sqliteOpenAttempts, openHandles: databases.size, closedHandles: sqliteClosedHandles, verifiedDescriptors } },
    close() { for (const database of databases.values()) database.close(); databases.clear(); for (const descriptor of descriptors) { try { fs.closeSync(descriptor) } catch {} }; descriptors.clear() },
  }
}
