/** The lazy yauzl API used by EPUB import, without Node streams or native code.
 * Central-directory metadata is indexed before any entry is inflated. Only an
 * explicitly opened entry is decompressed, with bounded input chunks, length
 * validation and CRC validation. Images/fonts are never eagerly expanded. */
import { EventEmitter } from 'events'
import { Buffer } from 'buffer'
import { Inflate } from 'fflate'
import { Readable } from 'stream'

interface Options {
  autoClose?: boolean
  lazyEntries?: boolean
  decodeStrings?: boolean
  validateEntrySizes?: boolean
  strictFileNames?: boolean
}
function invalid(message = 'Invalid ZIP archive'): never { throw new Error(message) }
const CRC_TABLE = new Uint32Array(256).map((_, i) => {
  let value = i
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return crc >>> 0
}
const crc32 = (bytes: Uint8Array): number => (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
const utf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
function filename(bytes: Uint8Array, unicode: boolean): string {
  if (unicode) return utf8(bytes)
  return Array.from(bytes, value => value < 128 ? String.fromCharCode(value) : CP437_HIGH[value - 128]).join('')
}
function assertRange(buffer: Buffer, offset: number, length: number, end = buffer.length): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset > end || length > end - offset || end > buffer.length) invalid()
}
function uint64(buffer: Buffer, offset: number): number {
  assertRange(buffer, offset, 8)
  const value = buffer.readUInt32LE(offset) + buffer.readUInt32LE(offset + 4) * 4294967296
  if (!Number.isSafeInteger(value)) invalid('ZIP64 value exceeds the safe integer range')
  return value
}

export class Entry {
  fileName: any = ''
  fileComment: any = ''
  versionMadeBy = 0
  versionNeededToExtract = 0
  extraFields: Array<{ id: number; data: Buffer }> = []
  uncompressedSize = 0
  compressedSize = 0
  compressionMethod = 0
  generalPurposeBitFlag = 0
  crc32 = 0
  relativeOffsetOfLocalHeader = 0
  externalFileAttributes = 0
  internalFileAttributes = 0
  private owner: ZipFile
  constructor(owner: ZipFile) { this.owner = owner }
  isEncrypted(): boolean { return (this.generalPurposeBitFlag & 0x41) !== 0 }
  isCompressed(): boolean { return this.compressionMethod === 8 }
  belongsTo(zip: ZipFile): boolean { return this.owner === zip }
}

/** Async iterable subset of Readable used by extractEpubChapters. The iterator
 * decompresses on demand and destroy() immediately stops further work. */
export class EntryReadStream extends EventEmitter implements AsyncIterable<Buffer> {
  destroyed = false
  private consumed = false
  constructor(private compressed: Buffer | AsyncIterable<Buffer>, private entry: Entry) { super() }
  destroy(error?: Error): this {
    this.destroyed = true
    if (error && this.listenerCount('error')) this.emit('error', error)
    this.emit('close')
    return this
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    if (this.consumed) invalid('ZIP entry stream has already been consumed')
    this.consumed = true
    let emittedBytes = 0
    let checksum = 0xffffffff
    const inspect = (bytes: Uint8Array): Buffer => {
      emittedBytes += bytes.length
      if (emittedBytes > this.entry.uncompressedSize) invalid('ZIP entry exceeds declared size')
      checksum = updateCrc(checksum, bytes)
      return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
    }
    try {
      const input = Buffer.isBuffer(this.compressed) ? [this.compressed] : this.compressed
      let chunks: Buffer[] = []
      const inflater = this.entry.compressionMethod === 8 ? new Inflate(bytes => { if (bytes.length) chunks.push(inspect(bytes)) }) : undefined
      let readBytes = 0
      for await (const inputChunk of input) {
        readBytes += inputChunk.length
        if (readBytes > this.entry.compressedSize) invalid('ZIP compressed size mismatch')
        for (let i = 0; i < inputChunk.length && !this.destroyed; i += 1024) {
          const chunk = inputChunk.subarray(i, Math.min(i + 1024, inputChunk.length))
          if (inflater) {
            inflater.push(chunk, false)
            for (const output of chunks) { if (this.destroyed) break; yield output }
            chunks = []
          } else yield inspect(chunk)
        }
        if (this.destroyed) return
      }
      if (readBytes !== this.entry.compressedSize) invalid('ZIP compressed size mismatch')
      if (inflater) {
        inflater.push(new Uint8Array(0), true)
        for (const output of chunks) { if (this.destroyed) break; yield output }
      }
      if (this.destroyed) return
      if (emittedBytes !== this.entry.uncompressedSize) invalid('ZIP entry size mismatch')
      if (((checksum ^ 0xffffffff) >>> 0) !== this.entry.crc32) invalid('ZIP entry CRC mismatch')
      this.emit('end')
    } finally { this.destroyed = true }
  }
}

export class ZipFile extends EventEmitter {
  readonly entryCount: number
  readonly autoClose: boolean
  readonly lazyEntries: boolean
  isOpen = true
  comment: string | Buffer = ''
  private offset: number
  private directoryStart: number
  private directoryEnd: number
  private seen = 0
  private pending = false
  private ended = false
  constructor(private buffer: Buffer, private options: Options = {}, private external?: { reader: RandomAccessReader; directoryStart: number }) {
    super()
    this.autoClose = options.autoClose ?? true
    this.lazyEntries = options.lazyEntries ?? false
    let eocd = -1
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
        eocd = i; break
      }
    }
    if (eocd < 0) invalid('Missing ZIP central directory')
    this.comment = options.decodeStrings === false ? buffer.subarray(eocd + 22) : filename(buffer.subarray(eocd + 22), false)
    if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0
      || buffer.readUInt16LE(eocd + 8) !== buffer.readUInt16LE(eocd + 10)) invalid('Multi-volume ZIP is unsupported')
    let count = buffer.readUInt16LE(eocd + 10)
    let size = buffer.readUInt32LE(eocd + 12)
    let offset = buffer.readUInt32LE(eocd + 16)
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      const locator = eocd - 20
      assertRange(buffer, locator, 20)
      if (buffer.readUInt32LE(locator) !== 0x07064b50 || buffer.readUInt32LE(locator + 4) !== 0
        || buffer.readUInt32LE(locator + 16) !== 1) invalid('Invalid ZIP64 locator')
      const record = uint64(buffer, locator + 8)
      assertRange(buffer, record, 56, locator)
      if (buffer.readUInt32LE(record) !== 0x06064b50 || uint64(buffer, record + 4) < 44
        || buffer.readUInt32LE(record + 16) !== 0 || buffer.readUInt32LE(record + 20) !== 0
        || uint64(buffer, record + 24) !== uint64(buffer, record + 32)) invalid('Invalid ZIP64 directory')
      count = uint64(buffer, record + 32)
      size = uint64(buffer, record + 40)
      offset = uint64(buffer, record + 48)
    }
    assertRange(buffer, offset, size, eocd)
    if (count > Math.floor(size / 46)) invalid('Invalid ZIP entry count')
    this.entryCount = count
    this.offset = offset
    this.directoryStart = offset
    this.directoryEnd = offset + size
  }
  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.emit('close')
  }
  readEntry(): void {
    if (!this.isOpen || this.pending || this.ended) return
    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      if (!this.isOpen) return
      try {
        if (this.seen === this.entryCount) {
          if (this.offset !== this.directoryEnd) invalid('Unexpected central directory data')
          this.ended = true
          this.emit('end')
          if (this.autoClose) this.close()
          return
        }
        const entry = this.nextEntry()
        this.seen++
        this.emit('entry', entry)
        if (!this.lazyEntries) this.readEntry()
      } catch (error) { this.emit('error', error instanceof Error ? error : new Error(String(error))) }
    })
  }
  private nextEntry(): Entry {
    const buffer = this.buffer
    const at = this.offset
    assertRange(buffer, at, 46, this.directoryEnd)
    if (buffer.readUInt32LE(at) !== 0x02014b50) invalid('Invalid ZIP directory entry')
    const entry = new Entry(this)
    entry.versionMadeBy = buffer.readUInt16LE(at + 4)
    entry.versionNeededToExtract = buffer.readUInt16LE(at + 6)
    entry.generalPurposeBitFlag = buffer.readUInt16LE(at + 8)
    entry.compressionMethod = buffer.readUInt16LE(at + 10)
    entry.crc32 = buffer.readUInt32LE(at + 16)
    entry.compressedSize = buffer.readUInt32LE(at + 20)
    entry.uncompressedSize = buffer.readUInt32LE(at + 24)
    entry.externalFileAttributes = buffer.readUInt32LE(at + 38)
    entry.internalFileAttributes = buffer.readUInt16LE(at + 36)
    entry.relativeOffsetOfLocalHeader = buffer.readUInt32LE(at + 42)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const diskNumber = buffer.readUInt16LE(at + 34)
    assertRange(buffer, at + 46, nameLength + extraLength + commentLength, this.directoryEnd)
    const rawName = buffer.subarray(at + 46, at + 46 + nameLength)
    entry.fileName = filename(rawName, (entry.generalPurposeBitFlag & 0x800) !== 0)
    const rawComment = buffer.subarray(at + 46 + nameLength + extraLength, at + 46 + nameLength + extraLength + commentLength)
    entry.fileComment = this.options.decodeStrings === false ? rawComment : filename(rawComment, false)
    const extraEnd = at + 46 + nameLength + extraLength
    let zip64 = false
    for (let extra = at + 46 + nameLength; extra < extraEnd;) {
      assertRange(buffer, extra, 4, extraEnd)
      const id = buffer.readUInt16LE(extra)
      const length = buffer.readUInt16LE(extra + 2)
      extra += 4
      assertRange(buffer, extra, length, extraEnd)
      entry.extraFields.push({ id, data: buffer.subarray(extra, extra + length) })
      if (id === 1) {
        let field = extra
        const next = (): number => { assertRange(buffer, field, 8, extra + length); const v = uint64(buffer, field); field += 8; return v }
        if (entry.uncompressedSize === 0xffffffff) entry.uncompressedSize = next()
        if (entry.compressedSize === 0xffffffff) entry.compressedSize = next()
        if (entry.relativeOffsetOfLocalHeader === 0xffffffff) entry.relativeOffsetOfLocalHeader = next()
        if (diskNumber === 0xffff) {
          assertRange(buffer, field, 4, extra + length)
          if (buffer.readUInt32LE(field) !== 0) invalid('Multi-volume ZIP is unsupported')
        }
        zip64 = true
      }
      if (id === 0x7075 && length >= 5 && buffer[extra] === 1
        && buffer.readUInt32LE(extra + 1) === crc32(rawName)) entry.fileName = utf8(buffer.subarray(extra + 5, extra + length))
      extra += length
    }
    if ((diskNumber !== 0 && diskNumber !== 0xffff) || (diskNumber === 0xffff && !zip64)) invalid()
    if (entry.uncompressedSize === 0xffffffff || entry.compressedSize === 0xffffffff
      || entry.relativeOffsetOfLocalHeader === 0xffffffff) invalid('Missing ZIP64 metadata')
    if (!this.options.strictFileNames) entry.fileName = entry.fileName.replace(/\\/g, '/')
    if (!entry.fileName || entry.fileName.includes('\0') || entry.fileName.includes('\\')
      || entry.fileName.startsWith('/') || /^[a-z]:/i.test(entry.fileName)
      || entry.fileName.split('/').includes('..')) invalid('Unsafe ZIP filename')
    if (entry.compressionMethod === 0 && !entry.isEncrypted()
      && entry.compressedSize !== entry.uncompressedSize) invalid('Stored ZIP entry size mismatch')
    if (this.options.decodeStrings === false) entry.fileName = Buffer.from(rawName)
    this.offset = extraEnd + commentLength
    return entry
  }
  openReadStream(entry: Entry, callback: (error: Error | null, stream?: EntryReadStream) => void): void {
    if (this.external) {
      const external = this.external
      void (async () => {
        if (!this.isOpen || !entry.belongsTo(this)) invalid('ZIP archive is closed or entry is foreign')
        if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) invalid('Unsupported ZIP entry')
        const at = entry.relativeOffsetOfLocalHeader
        if (at < 0 || at + 30 > external.directoryStart) invalid()
        const header = await readRange(external.reader, at, at + 30)
        if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== entry.compressionMethod
          || header.readUInt16LE(6) !== entry.generalPurposeBitFlag) invalid('Invalid ZIP local header')
        const start = at + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
        if (start + entry.compressedSize > external.directoryStart) invalid()
        return new EntryReadStream(external.reader._readStreamForRange(start, start + entry.compressedSize), entry)
      })().then(stream => callback(null, stream), error => callback(error))
      return
    }
    queueMicrotask(() => {
      let stream: EntryReadStream
      try {
        if (!this.isOpen || !entry.belongsTo(this)) invalid('ZIP archive is closed or entry is foreign')
        if (entry.isEncrypted()) invalid('Encrypted ZIP entry')
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) invalid('Unsupported ZIP compression')
        const at = entry.relativeOffsetOfLocalHeader
        assertRange(this.buffer, at, 30, this.directoryStart)
        if (this.buffer.readUInt32LE(at) !== 0x04034b50
          || this.buffer.readUInt16LE(at + 8) !== entry.compressionMethod
          || this.buffer.readUInt16LE(at + 6) !== entry.generalPurposeBitFlag) invalid('Invalid ZIP local header')
        const start = at + 30 + this.buffer.readUInt16LE(at + 26) + this.buffer.readUInt16LE(at + 28)
        assertRange(this.buffer, start, entry.compressedSize, this.directoryStart)
        const bytes = this.buffer.subarray(start, start + entry.compressedSize)
        stream = new EntryReadStream(Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength), entry)
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); return }
      callback(null, stream)
    })
  }
}

export class RandomAccessReader extends EventEmitter {
  _readStreamForRange(_start: number, _end: number): Readable { throw new Error('Random access reader is not implemented') }
  close(callback: (error: Error | null) => void): void { queueMicrotask(() => callback(null)) }
}

async function readRange(reader: RandomAccessReader, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of reader._readStreamForRange(start, end)) {
    const bytes = Buffer.from(chunk)
    length += bytes.length
    if (length > end - start) invalid('ZIP reader exceeded range')
    chunks.push(bytes)
  }
  if (length !== end - start) invalid('Truncated ZIP range')
  return Buffer.concat(chunks, length)
}

/** Index bounded central-directory metadata; payload bytes stay on disk until read. */
export function fromRandomAccessReader(reader: RandomAccessReader, size: number, options: Options,
  callback: (error: Error | null, zip?: ZipFile) => void): void {
  void (async () => {
    if (!Number.isSafeInteger(size) || size < 22) invalid()
    const tailStart = Math.max(0, size - 65557)
    const tail = await readRange(reader, tailStart, size)
    let end = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break }
    }
    if (end < 0) invalid()
    let count = tail.readUInt16LE(end + 10)
    let directorySize = tail.readUInt32LE(end + 12)
    let directoryStart = tail.readUInt32LE(end + 16)
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count) invalid()
    if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
      const locatorPosition = tailStart + end - 20
      const locator = await readRange(reader, locatorPosition, locatorPosition + 20)
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) invalid()
      const recordPosition = uint64(locator, 8)
      const record = await readRange(reader, recordPosition, recordPosition + 56)
      if (record.readUInt32LE(0) !== 0x06064b50 || uint64(record, 4) !== 44 || record.readUInt32LE(16) || record.readUInt32LE(20)
        || uint64(record, 24) !== uint64(record, 32) || recordPosition + 56 !== locatorPosition) invalid()
      count = uint64(record, 32); directorySize = uint64(record, 40); directoryStart = uint64(record, 48)
    }
    // Metadata bounds are independent of declared payload sizes.
    if (count >= 65535 || directorySize > 32 * 1024 * 1024 || directoryStart + directorySize > tailStart + end) invalid('ZIP directory exceeds Android limits')
    const directory = await readRange(reader, directoryStart, directoryStart + directorySize)
    const trailer = Buffer.from(tail.subarray(end))
    trailer.writeUInt16LE(count, 8); trailer.writeUInt16LE(count, 10)
    trailer.writeUInt32LE(directorySize, 12); trailer.writeUInt32LE(0, 16)
    return new ZipFile(Buffer.concat([directory, trailer]), options, { reader, directoryStart })
  })().then(zip => { callback(null, zip); if (!zip.lazyEntries) zip.readEntry() }, error => callback(error))
}

export function fromBuffer(buffer: Buffer, options: Options,
  callback: (error: Error | null, zip?: ZipFile) => void): void {
  queueMicrotask(() => {
    let zip: ZipFile
    try { zip = new ZipFile(buffer, options) }
    catch (error) { callback(error instanceof Error ? error : new Error(String(error))); return }
    callback(null, zip)
    if (!zip.lazyEntries) zip.readEntry()
  })
}
