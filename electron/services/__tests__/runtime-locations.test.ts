import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeLocations, inspectRuntimeDirectory, parseRuntimeLocations, readPackagedRuntimeLocations,
  resolveDesktopRuntimeLocations, resolveRuntimeLocations, runtimeLocationFailureReason, summarizeRuntimeLocations, type RuntimeLocationsDescriptor } from '../runtime-locations'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const owned = new Set<string>()
function temporary(parent = path.join(root, '.runtime'), prefix = 'runtime-locations-test-') {
  const directory = path.join(parent, prefix + randomUUID().slice(0, 8))
  fs.mkdirSync(directory); owned.add(directory)
  return directory
}
afterEach(() => {
  for (const directory of owned) {
    const parent = path.dirname(directory)
    if (parent !== path.join(root, '.runtime') && parent !== path.dirname(root)) throw new Error('Unexpected test cleanup target')
    fs.rmSync(directory, { recursive: true, force: true })
  }
  owned.clear()
})
const identity = { device: '17', inode: '29' }
function descriptor(): RuntimeLocationsDescriptor {
  return { format: 'ai-novel-runtime-locations', version: 1, locations: {
    globalDataHome: { path: 'D:\\profile\\global', identity },
    userData: { path: 'D:\\profile\\chromium', identity },
    legacySource: { path: 'D:\\profile\\legacy-empty', identity },
    syncProjectsHome: { path: 'D:\\Synced-Novels', identity },
  } }
}
function fails(operation: () => unknown, reason: string) {
  try { operation(); throw new Error('Expected startup to be blocked') }
  catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('GLOBAL_DATA_BLOCKED')
    expect(runtimeLocationFailureReason(error)).toBe(reason)
  }
}

describe('public runtime-location descriptor', () => {
  it('contains only four local paths and directory identity metadata', () => {
    expect(parseRuntimeLocations(descriptor())).toEqual(descriptor())
    const input = { ...descriptor(), apiKey: 'must-never-be-packaged' }
    fails(() => parseRuntimeLocations(input), 'descriptor-invalid')
    const invalid = descriptor(); Object.assign(invalid.locations.userData, { apiKey: 'unexpected' })
    fails(() => parseRuntimeLocations(invalid), 'descriptor-invalid')
  })

  it.each(['D:\\', 'D:relative', '..\\project', '\\\\server\\share', '\\\\?\\D:\\profile',
    'D:\\profile\\..\\elsewhere', 'D:\\profile\\NUL', 'D:\\profile\\space ', 'D:\\profile\\dot.', 'D:\\profile:stream'])('rejects unsafe path %s', value => {
    const input = descriptor(); input.locations.globalDataHome.path = value
    fails(() => parseRuntimeLocations(input), 'unsafe-path')
  })

  it('rejects case-insensitive equal or nested roots and overly long novel destinations', () => {
    const input = descriptor(); input.locations.userData.path = 'd:\\PROFILE\\global\\chromium'
    fails(() => parseRuntimeLocations(input), 'overlap')
    input.locations.userData.path = 'D:\\profile\\chromium'
    input.locations.syncProjectsHome.path = 'D:\\' + 'x'.repeat(69)
    fails(() => parseRuntimeLocations(input), 'unsafe-path')
  })

  it('requires existing-root identity, allowing a missing-leaf parent binding only for novels', () => {
    const input = descriptor(); input.locations.syncProjectsHome = { path: 'D:\\Synced-Novels', parentIdentity: identity }
    expect(parseRuntimeLocations(input)).toEqual(input)
    input.locations.userData = { path: 'D:\\profile\\chromium', parentIdentity: identity }
    fails(() => parseRuntimeLocations(input), 'descriptor-invalid')
  })
})

describe('startup selection and isolation', () => {
  it('prints only drives and exact-path digests for the read-only installed EXE verification', () => {
    const locations = Object.fromEntries(Object.entries(descriptor().locations).map(([name, value]) => [name, value.path])) as Record<keyof RuntimeLocationsDescriptor['locations'], string>
    const report = summarizeRuntimeLocations(locations, true, 'win32')
    expect(report).toMatchObject({ status: 'verified', descriptorApplied: true, locations: { globalDataHome: { drive: 'D:\\',
      pathSha256: createHash('sha256').update('d:\\profile\\global').digest('hex') } } })
    expect(JSON.stringify(report)).not.toContain('profile')
    expect(JSON.stringify(report)).not.toContain('identity')
    expect(summarizeRuntimeLocations({ ...locations, globalDataHome: 'd:/PROFILE/global/' }, true, 'win32').locations.globalDataHome)
      .toEqual(report.locations.globalDataHome)
  })
  it('keeps standard defaults without a descriptor and never inspects source directories', () => {
    const inspect = vi.fn(() => identity)
    expect(resolveRuntimeLocations({ env: {}, inspectDirectory: inspect })).toEqual({ userData: undefined, environment: {}, descriptorApplied: false })
    expect(inspect).not.toHaveBeenCalled()
    expect(resolveRuntimeLocations({ env: { AI_NOVEL_ELECTRON_USER_DATA_DIR: path.resolve(root, '.runtime', 'explicit-user') }, inspectDirectory: inspect }).userData)
      .toBe(path.resolve(root, '.runtime', 'explicit-user'))
  })

  it('binds the existing data locations before either a launcher or shortcut acquires a profile lock', () => {
    const inspect = vi.fn(() => identity)
    expect(resolveRuntimeLocations({ env: {}, descriptor: descriptor(), inspectDirectory: inspect })).toEqual({
      userData: 'D:\\profile\\chromium', descriptorApplied: true,
      environment: { AI_NOVEL_APP_DATA_HOME: 'D:\\profile\\global', AI_NOVEL_ELECTRON_USER_DATA_DIR: 'D:\\profile\\chromium',
        AI_NOVEL_LEGACY_SOURCE_HOME: 'D:\\profile\\legacy-empty', AI_NOVEL_SYNC_PROJECTS_HOME: 'D:\\Synced-Novels' },
    })
    expect(inspect).toHaveBeenCalledTimes(4)
  })

  it('gives CLI userData priority over environment and overrides priority over descriptor identity', () => {
    const inspect = vi.fn(() => identity)
    const result = resolveRuntimeLocations({ descriptor: descriptor(), env: { AI_NOVEL_ELECTRON_USER_DATA_DIR: 'D:\\env-profile',
      AI_NOVEL_APP_DATA_HOME: 'D:\\env-global', AI_NOVEL_VELA_HOME: 'D:\\env-legacy' }, cliUserData: 'D:\\cli-profile', inspectDirectory: inspect })
    expect(result.userData).toBe('D:\\cli-profile')
    expect(result.environment).toEqual({ AI_NOVEL_SYNC_PROJECTS_HOME: 'D:\\Synced-Novels' })
    expect(inspect).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledWith('D:\\Synced-Novels')
  })

  it('blocks replaced or unavailable D directories without falling back to an empty profile', () => {
    fails(() => resolveRuntimeLocations({ env: {}, descriptor: descriptor(), inspectDirectory: () => ({ device: '17', inode: '30' }) }), 'unsafe-path')
    fails(() => resolveRuntimeLocations({ env: {}, descriptor: descriptor(), inspectDirectory: () => { throw Object.assign(new Error('GLOBAL_DATA_BLOCKED'), { runtimeLocationReason: 'location-unavailable' }) } }), 'location-unavailable')
  })

  it('prevents an installer/uninstaller owning any selected data directory', () => {
    fails(() => resolveRuntimeLocations({ env: {}, descriptor: descriptor(), inspectDirectory: () => identity, installationRoot: 'D:\\profile' }), 'overlap')
    fails(() => resolveRuntimeLocations({ env: { AI_NOVEL_APP_DATA_HOME: 'D:\\Programs\\Writer\\data' }, descriptor: descriptor(),
      inspectDirectory: () => identity, installationRoot: 'D:\\Programs\\Writer' }), 'overlap')
  })

  it('complete explicit recovery/test overrides do not even read the personal descriptor', () => {
    const env = { AI_NOVEL_APP_DATA_HOME: path.resolve(root, '.runtime', 'isolated-global'), AI_NOVEL_ELECTRON_USER_DATA_DIR: path.resolve(root, '.runtime', 'isolated-user'),
      AI_NOVEL_LEGACY_SOURCE_HOME: path.resolve(root, '.runtime', 'isolated-legacy'), AI_NOVEL_SYNC_PROJECTS_HOME: path.resolve(root, '.runtime', 'isolated-novels') }
    expect(resolveDesktopRuntimeLocations({ env, resourcesDirectory: 'missing-resources', applicationDirectory: 'missing-app', platform: 'win32', packaged: true }))
      .toEqual({ userData: env.AI_NOVEL_ELECTRON_USER_DATA_DIR, environment: {}, descriptorApplied: false })
  })
})

describe('packaged descriptor integrity', () => {
  function files(marker: boolean) {
    const directory = temporary(), app = path.join(directory, 'app'), resources = path.join(directory, 'resources')
    fs.mkdirSync(app); fs.mkdirSync(resources)
    const bytes = JSON.stringify(descriptor())
    fs.writeFileSync(path.join(resources, 'runtime-locations.json'), bytes)
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(marker ? { aiNovelRuntimeLocations: { version: 1, required: true,
      sha256: createHash('sha256').update(bytes).digest('hex') } } : {}))
    return { app, resources }
  }
  it('reads only the bounded public descriptor and immutable app metadata', () => {
    const { app, resources } = files(true)
    expect(readPackagedRuntimeLocations(resources, 'win32', true, app)).toEqual(descriptor())
    expect(readPackagedRuntimeLocations('missing', 'android', true, 'missing')).toBeUndefined()
    expect(readPackagedRuntimeLocations('missing', 'win32', false, 'missing')).toBeUndefined()
  })
  it('treats an absent unconfigured descriptor as ordinary upstream behavior', () => {
    const { app, resources } = files(false); fs.unlinkSync(path.join(resources, 'runtime-locations.json'))
    expect(readPackagedRuntimeLocations(resources, 'win32', true, app)).toBeUndefined()
  })
  it('fails closed if a personal descriptor is removed or changed', () => {
    const { app, resources } = files(true), file = path.join(resources, 'runtime-locations.json')
    fs.appendFileSync(file, '\n')
    fails(() => readPackagedRuntimeLocations(resources, 'win32', true, app), 'descriptor-invalid')
    fs.unlinkSync(file)
    fails(() => readPackagedRuntimeLocations(resources, 'win32', true, app), 'location-unavailable')
  })
  it('rejects oversized or hardlinked files', () => {
    const { app, resources } = files(false), file = path.join(resources, 'runtime-locations.json')
    fs.writeFileSync(file, 'x'.repeat(16385))
    fails(() => readPackagedRuntimeLocations(resources, 'win32', true, app), 'unsafe-path')
    fs.writeFileSync(file, JSON.stringify(descriptor())); fs.linkSync(file, path.join(resources, 'alias.json'))
    fails(() => readPackagedRuntimeLocations(resources, 'win32', true, app), 'unsafe-path')
  })
})

describe.skipIf(process.platform !== 'win32')('metadata-only preparation on Windows', () => {
  function source() {
    const base = temporary(path.dirname(root), '.rl-')
    const paths = { globalDataHome: path.join(base, 'g'), userData: path.join(base, 'u'), legacySource: path.join(base, 'l'), syncProjectsHome: path.join(base, 'n') }
    for (const directory of Object.values(paths).slice(0, 3)) fs.mkdirSync(directory)
    fs.mkdirSync(path.join(paths.globalDataHome, '.migration'))
    fs.writeFileSync(path.join(paths.globalDataHome, '.migration', 'receipt.json'), 'fixture; only metadata is read')
    return paths
  }
  it('records actual existing identities and permits a new novel directory without creating it', () => {
    const paths = source(), result = createRuntimeLocations(paths)
    expect(result.locations.globalDataHome.identity).toEqual(inspectRuntimeDirectory(paths.globalDataHome))
    expect(result.locations.syncProjectsHome.parentIdentity).toEqual(inspectRuntimeDirectory(path.dirname(paths.syncProjectsHome)))
    expect(fs.existsSync(paths.syncProjectsHome)).toBe(false)
    fs.mkdirSync(paths.syncProjectsHome)
    expect(resolveRuntimeLocations({ env: {}, descriptor: result }).userData).toBe(paths.userData)
    fs.rmSync(paths.userData, { recursive: true }); fs.writeFileSync(paths.userData, 'replacement file')
    fails(() => resolveRuntimeLocations({ env: {}, descriptor: result }), 'unsafe-path')
  })
  it('does not accept uninitialized global data or a junction in its directory chain', () => {
    const paths = source(); fs.unlinkSync(path.join(paths.globalDataHome, '.migration', 'receipt.json'))
    fails(() => createRuntimeLocations(paths), 'location-unavailable')
    const alias = path.join(path.dirname(paths.globalDataHome), 'alias')
    fs.symlinkSync(paths.userData, alias, 'junction')
    fails(() => inspectRuntimeDirectory(alias), 'unsafe-path')
  })
  it('generates an explicit NSIS overlay with only descriptor resources and refuses overwrite', () => {
    const paths = source(), output = path.join(root, '.runtime', 'windows-test-' + randomUUID().slice(0, 8))
    owned.add(output)
    const args = ['--experimental-strip-types', path.join(root, 'scripts', 'prepare-windows-runtime-locations.mjs'),
      `--app-data-home=${paths.globalDataHome}`, `--user-data=${paths.userData}`, `--legacy-source=${paths.legacySource}`,
      `--sync-projects-home=${paths.syncProjectsHome}`, `--output=${output}`]
    const generated = spawnSync(process.execPath, args, { encoding: 'utf8' })
    expect(generated.stderr).toBe(''); expect(generated.status).toBe(0)
    const config = JSON.parse(fs.readFileSync(path.join(output, 'electron-builder.json'), 'utf8'))
    const bytes = fs.readFileSync(path.join(output, 'runtime-locations.json'))
    expect(config.extraMetadata.aiNovelRuntimeLocations.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(config.extraResources).toEqual([{ from: path.join(output, 'runtime-locations.json'), to: 'runtime-locations.json' }])
    expect(config.extends).toBe(path.join(root, 'electron-builder.json5'))
    expect(config.nsis.runAfterFinish).toBe(false)
    expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).not.toBe(0)
    expect(fs.readFileSync(path.join(output, 'runtime-locations.json'))).toEqual(bytes)
  })
})
