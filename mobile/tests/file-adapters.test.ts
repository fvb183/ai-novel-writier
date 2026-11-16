import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { extractEpubChapters } from '../../electron/services/epub-extraction-service'
import { createSecureFileCapability, createSecureFileSystem, normalizeSecureRelativePath } from '../shims/secure-fs'
import { fromBuffer, fromRandomAccessReader, RandomAccessReader, type ZipFile } from '../shims/yauzl'
import { Readable } from 'node:stream'

const created: string[] = []
const fixture = (): string => { const p = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'anw-mobile-'))); created.push(p); return p }
afterEach(() => { for (const p of created.splice(0)) rmSync(p, { recursive: true, force: true }) })

function compressedBook(): Buffer {
  return Buffer.from(zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    'book.opf': strToU8('<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>'),
    'one.xhtml': strToU8(`<html><body><h1>夜色</h1><p>${'你好世界'.repeat(40_000)}</p></body></html>`),
    // Unread resources must never be expanded by the import adapter.
    'unused.bin': new Uint8Array(40 * 1024 * 1024),
  }, { level: 6 }))
}
const openZip = (bytes: Buffer): Promise<ZipFile> => new Promise((resolve, reject) => {
  fromBuffer(bytes, { autoClose: false, lazyEntries: true, strictFileNames: true }, (error, zip) => {
    if (error || !zip) reject(error)
    else resolve(zip)
  })
})

describe('Android file capability boundaries', () => {
  it.each(['../secret', '/etc/passwd', 'C:\\secret', '\\\\host\\secret', 'a\\..\\secret', 'a\0b', 'x:stream', 'NUL'])
    ('rejects unsafe relative path %j', (value) => {
      expect(() => normalizeSecureRelativePath(value)).toThrow('SECURE_FS_INVALID_PATH')
    })
  it('rejects sibling-prefix escape and replacement of an authorized root', async () => {
    const root = fixture()
    const project = path.join(root, 'project')
    mkdirSync(project)
    expect(() => createSecureFileCapability(project, `${project}-other/file`)).toThrow('SECURE_FS_INVALID_PATH')
    const capability = createSecureFileCapability(project, path.join(project, 'story.md'))
    rmSync(project, { recursive: true })
    mkdirSync(project)
    // Replacing with a symlink cannot gain authority, regardless of inode reuse.
    rmSync(project, { recursive: true })
    symlinkSync(root, project, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createSecureFileSystem().exists(capability)).rejects.toThrow('SECURE_FS_INVALID_PATH')
  })
  it('rejects symlink components even when pointing inside the authorized root', async () => {
    const root = fixture()
    mkdirSync(path.join(root, 'real'))
    writeFileSync(path.join(root, 'real', 'text.md'), 'secret')
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const capability = createSecureFileCapability(root, path.join(root, 'link', 'text.md'))
    await expect(createSecureFileSystem().exists(capability)).rejects.toThrow('SECURE_FS_INVALID_PATH')
  })
  it('preserves directory operations and checks returned entry names', async () => {
    const root = fixture()
    const secure = createSecureFileSystem()
    await secure.mkdir(createSecureFileCapability(root, path.join(root, 'book', 'chapters')))
    await expect(secure.listDirectory(createSecureFileCapability(root, root)))
      .resolves.toEqual([{ name: 'book', isDirectory: true }])
    const injected = createSecureFileSystem({ invoke: async () => ({ ok: true, entries: [{ name: '../outside', isDirectory: false }] }) })
    await expect(injected.listDirectory(createSecureFileCapability(root, root))).rejects.toThrow('SECURE_FS_INVALID_PATH')
  })
})

describe('Android EPUB streaming adapter', () => {
  it('reads raw ZIP metadata and streams requested file ranges without loading the archive', async () => {
    const payload = strToU8('正文'.repeat(250000))
    const bytes = Buffer.from(zipSync({ 'story.txt': payload, 'unused.bin': new Uint8Array(3000000) }, { level: 0 }))
    const requests: Array<[number, number]> = []
    class Reader extends RandomAccessReader {
      _readStreamForRange(start: number, end: number): Readable {
        requests.push([start, end])
        return Readable.from((async function* () {
          for (let i = start; i < end; i += 4096) yield bytes.subarray(i, Math.min(i + 4096, end))
        })())
      }
    }
    const archive = await new Promise<ZipFile>((resolve, reject) => {
      fromRandomAccessReader(new Reader(), bytes.length, { lazyEntries: true, autoClose: false, decodeStrings: false },
        (error, zip) => error || !zip ? reject(error) : resolve(zip))
    })
    expect(requests.every(([start, end]) => end - start <= 65557)).toBe(true)
    const first: any = await new Promise((resolve, reject) => {
      archive.once('error', reject); archive.once('entry', resolve); archive.readEntry()
    })
    expect(Buffer.isBuffer(first.fileName)).toBe(true)
    expect(first.fileName.toString()).toBe('story.txt')
    expect(first.fileComment.length).toBe(0)
    const stream = await new Promise<any>((resolve, reject) => archive.openReadStream(first, (error, stream) => error ? reject(error) : resolve(stream)))
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(payload))
    expect(requests.some(([start, end]) => start === 0 && end === bytes.length)).toBe(false)
    archive.close()
  })
  it('extracts deflated Unicode text and leaves a large unused resource compressed', async () => {
    const chapters = await extractEpubChapters(compressedBook())
    expect(chapters).toEqual([{ title: '夜色', content: `夜色\n\n${'你好世界'.repeat(40_000)}` }])
  })
  it('rejects a dishonest expanded size without allocating the whole expanded resource', async () => {
    const zip = Buffer.from(zipSync({ 'bomb.txt': new Uint8Array(8 * 1024 * 1024) }, { level: 9 }))
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(1, central + 24)
    const archive = await openZip(zip)
    const result = new Promise<void>((resolve, reject) => {
      archive.once('error', reject)
      archive.once('entry', entry => {
        archive.openReadStream(entry, async (error, stream) => {
          try {
            if (error || !stream) throw error
            for await (const _chunk of stream) { /* the first inflation must fail */ }
            resolve()
          } catch (failure) { reject(failure) }
        })
      })
      archive.readEntry()
    })
    await expect(result).rejects.toThrow('ZIP entry exceeds declared size')
    archive.close()
  })
  it('rejects a corrupted CRC', async () => {
    const zip = Buffer.from(zipSync({ 'test.txt': strToU8('hello') }, { level: 0 }))
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(0, central + 16)
    const archive = await openZip(zip)
    const result = new Promise<void>((resolve, reject) => {
      archive.once('error', reject)
      archive.once('entry', entry => archive.openReadStream(entry, async (error, stream) => {
        try { if (error || !stream) throw error; for await (const _chunk of stream) { /* consume */ }; resolve() }
        catch (failure) { reject(failure) }
      }))
      archive.readEntry()
    })
    await expect(result).rejects.toThrow('ZIP entry CRC mismatch')
    archive.close()
  })
})
