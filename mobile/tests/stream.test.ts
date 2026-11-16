import { describe, expect, it, vi } from 'vitest'
import { Buffer } from 'buffer'
import Stream, { Readable, Writable } from '../shims/stream'

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const closed = (stream: InstanceType<typeof Readable>) => new Promise<void>(resolve => stream.once('close', resolve))
const collect = async (stream: InstanceType<typeof Readable>) => {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Android iterable streams', () => {
  it('does not eagerly read and pauses next() at the high water mark', async () => {
    const next = vi.fn(() => ({ value: next.mock.calls.length, done: false }))
    const finish = vi.fn(() => ({ done: true, value: undefined }))
    const stream = Readable.from({ [Symbol.iterator]: () => ({ next, return: finish }) }, { highWaterMark: 1 })
    expect(next).not.toHaveBeenCalled()
    stream.read(0)
    await tick()
    expect(next).toHaveBeenCalledTimes(1)
    expect(stream.readableLength).toBe(1)
    await tick()
    expect(next).toHaveBeenCalledTimes(1)
    expect(stream.read()).toBe(1)
    await tick()
    expect(next).toHaveBeenCalledTimes(2)
    const didClose = closed(stream)
    stream.destroy()
    await didClose
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('awaits asynchronous yielded values and keeps only one next() in flight', async () => {
    const first = deferred<IteratorResult<unknown>>()
    const value = deferred<string>()
    const next = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ done: true })
    const stream = Readable.from({ [Symbol.asyncIterator]: () => ({ next }) })
    const result = collect(stream)
    stream.read(0); stream.read(0)
    await tick()
    expect(next).toHaveBeenCalledTimes(1)
    first.resolve({ done: false, value: value.promise })
    await tick()
    expect(next).toHaveBeenCalledTimes(1)
    value.resolve('夜航')
    await expect(result).resolves.toEqual(['夜航'])
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('pipes binary archive chunks through the reused browser Writable', async () => {
    const chunks: Buffer[] = []
    const source = Readable.from((async function* () {
      yield Buffer.from('夜')
      yield Promise.resolve(Buffer.from('航'))
    })(), { objectMode: false })
    const target = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) { chunks.push(chunk); setTimeout(done, 0) },
    })
    const finished = new Promise<void>((resolve, reject) => {
      source.once('error', reject)
      target.once('error', reject)
      target.once('finish', resolve)
    })
    source.pipe(target)
    await finished
    expect(Buffer.concat(chunks).toString()).toBe('夜航')
    expect(Stream.Readable).toBe(Readable)
  })

  it('propagates an asynchronous source failure and closes its iterator', async () => {
    const failure = new Error('archive read failed')
    const finish = vi.fn(async () => ({ done: true, value: undefined }))
    const stream = Readable.from({ [Symbol.asyncIterator]: () => ({
      next: async () => { throw failure },
      return: finish,
    }) })
    await expect(collect(stream)).rejects.toBe(failure)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('calls return immediately on cancellation and discards a pending late chunk', async () => {
    const pending = deferred<IteratorResult<string>>()
    const cleanup = deferred<IteratorResult<string>>()
    const finish = vi.fn(() => cleanup.promise)
    const next = vi.fn(() => pending.promise)
    const stream = Readable.from({ [Symbol.asyncIterator]: () => ({ next, return: finish }) })
    const chunks: unknown[] = []
    stream.on('data', chunk => chunks.push(chunk))
    await tick()
    expect(next).toHaveBeenCalledTimes(1)
    const didClose = closed(stream)
    stream.destroy()
    expect(finish).toHaveBeenCalledTimes(1)
    cleanup.resolve({ done: true, value: undefined })
    await didClose
    pending.resolve({ done: false, value: 'must not escape' })
    await tick()
    stream.destroy()
    expect(chunks).toEqual([])
    expect(next).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('runs an async generator finally block when its consumer stops early', async () => {
    const finish = vi.fn()
    const stream = Readable.from((async function* () {
      try { yield 'first'; yield 'second' } finally { await tick(); finish() }
    })())
    for await (const chunk of stream) {
      expect(chunk).toBe('first')
      break
    }
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('consumes a cancelled read rejection without an error after close', async () => {
    const pending = deferred<IteratorResult<string>>()
    const stream = Readable.from({ [Symbol.asyncIterator]: () => ({
      next: () => pending.promise,
      return: async () => ({ done: true, value: undefined }),
    }) })
    const errors: Error[] = []
    stream.on('error', error => errors.push(error))
    stream.read(0)
    await tick()
    const didClose = closed(stream)
    stream.destroy()
    await didClose
    pending.reject(new Error('native operation cancelled'))
    await tick()
    expect(errors).toEqual([])
  })

  it('reports cleanup errors while preserving an original source error', async () => {
    for (const failure of [null, new Error('original')]) {
      const cleanupError = new Error('cleanup')
      const stream = Readable.from({ [Symbol.iterator]: () => ({
        next: () => ({ done: false, value: 'unused' }),
        return: () => { throw cleanupError },
      }) })
      const errors: Error[] = []
      stream.on('error', error => errors.push(error))
      const didClose = closed(stream)
      stream.destroy(failure ?? undefined)
      await didClose
      expect(errors).toEqual([failure ?? cleanupError])
    }
  })

  it('preserves string and Buffer chunks, rejects null and invalid iterables', async () => {
    await expect(collect(Readable.from('夜航'))).resolves.toEqual(['夜航'])
    const bytes = Buffer.from('夜航')
    await expect(collect(Readable.from(bytes))).resolves.toEqual([bytes])
    await expect(collect(Readable.from([null]))).rejects.toMatchObject({ code: 'ERR_STREAM_NULL_VALUES' })
    expect(() => Readable.from({} as Iterable<unknown>)).toThrow('requires an iterable')
  })
})
