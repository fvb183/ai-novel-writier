import BrowserStream from 'stream-browserify'
import { Buffer } from 'buffer'
import type { ReadableOptions } from 'node:stream'

const errorFrom = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))
const invalidResult = () => new TypeError('Iterator result must be an object')

/**
 * readable-stream deliberately disables Readable.from in its browser build.
 * Keep its stream implementation, but own the iterator lifecycle here so an
 * archive read observes backpressure and closes its source when cancelled.
 */
function from(iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: ReadableOptions) {
  // Like Node, a string or Buffer is one chunk rather than an iterable of bytes.
  const source = typeof iterable === 'string' || Buffer.isBuffer(iterable) ? [iterable] : iterable
  if (source == null) throw new TypeError('Readable.from requires an iterable')
  const iterator = Symbol.asyncIterator in Object(source)
    ? (source as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    : (source as Iterable<unknown>)[Symbol.iterator]?.()
  if (!iterator || typeof iterator.next !== 'function') throw new TypeError('Readable.from requires an iterable')

  let pulling = false
  let ended = false
  let closing: Promise<void> | undefined
  const closeIterator = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      if (ended || iterator.return === undefined) return
      const result = await iterator.return()
      if (result === null || typeof result !== 'object') throw invalidResult()
      // A synchronous generator may return a promise from its finally block.
      await result.value
    })()
    return closing
  }

  const readable = new BrowserStream.Readable({
    objectMode: true,
    highWaterMark: 1,
    autoDestroy: true,
    ...options,
    read() {
      if (pulling || ended || readable.destroyed) return
      pulling = true
      void pull()
    },
    destroy(error, done) {
      // Start return() immediately, including while next() is still pending.
      // A cooperative iterator can use it to cancel the underlying read.
      void closeIterator().then(
        () => done(error),
        closeError => done(error ?? errorFrom(closeError)),
      )
    },
  })

  async function pull(): Promise<void> {
    try {
      while (!readable.destroyed && !ended) {
        const result = await iterator.next()
        if (readable.destroyed) return
        if (result === null || typeof result !== 'object') throw invalidResult()
        if (result.done) {
          ended = true
          readable.push(null)
          return
        }
        const value = await result.value
        if (readable.destroyed) return
        if (value === null) {
          throw Object.assign(new TypeError('May not write null values to stream'), { code: 'ERR_STREAM_NULL_VALUES' })
        }
        // No additional next() until the consumer requests more buffer space.
        if (!readable.push(value)) return
      }
    } catch (error) {
      // A cancelled native read can reject after return() has already closed
      // the stream. Consume that rejection without emitting after close.
      if (!readable.destroyed) readable.destroy(errorFrom(error))
    } finally {
      pulling = false
    }
  }

  return readable
}

// Patch the shared constructor so named imports and Stream.Readable.from agree.
BrowserStream.Readable.from = from
export const { Readable, Writable, Duplex, Transform, PassThrough, finished, pipeline } = BrowserStream
export { BrowserStream as Stream }
export default BrowserStream
