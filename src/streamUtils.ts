import type { Writable } from 'node:stream'

/**
 * Accumulates items from any `Iterable` or `AsyncIterable` (including Node.js readable
 * streams) into fixed-size batches. The final batch may be smaller than `batchSize`.
 *
 * Useful for composing stream consumption with chunked processing — feed each batch
 * into {@link executeTwoPhaseChunksSequentially} or similar.
 *
 * @param source Any sync or async iterable.
 * @param batchSize Maximum items per yielded batch. Must be an integer >= 1; anything
 *   else throws a `RangeError` synchronously, before iteration starts.
 */
export function batchFromStream<T>(
  source: Iterable<T> | AsyncIterable<T>,
  batchSize: number,
): AsyncGenerator<T[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be an integer >= 1, received ${String(batchSize)}`)
  }
  return batchGenerator(source, batchSize)
}

async function* batchGenerator<T>(
  source: Iterable<T> | AsyncIterable<T>,
  batchSize: number,
): AsyncGenerator<T[]> {
  let batch: T[] = []

  for await (const item of source) {
    batch.push(item)
    if (batch.length >= batchSize) {
      yield batch
      batch = []
    }
  }

  if (batch.length > 0) {
    yield batch
  }
}

/**
 * Writes `data` to a `Writable` stream while respecting backpressure. Resolves when
 * the chunk has been accepted by the consumer (or after the next `drain` event when
 * the internal buffer was full). Rejects if the stream errors, is destroyed, or
 * closes before the write completes.
 *
 * Prefer `stream.pipeline()` when your data source can be expressed as a readable
 * stream or async iterable — `drainAwareWrite` is for the case where you write
 * imperatively in a loop and can't restructure as a pipeline.
 */
export function drainAwareWrite(stream: Writable, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    // Initial value covers the rare case where the write callback fires synchronously
    // during `stream.write(...)`, before the return value has been assigned. Reading
    // an uninitialized `const` would throw a TDZ ReferenceError.
    let canContinue = true

    const removeListeners = () => {
      stream.removeListener('error', onError)
      stream.removeListener('drain', onDrain)
      stream.removeListener('close', onClose)
    }

    const settle = (err?: Error | null) => {
      if (settled) return
      settled = true
      if (err) {
        // Defer listener removal to allow Node.js to emit the 'error' event that
        // follows a failed write callback on the next tick, so it does not surface
        // as an unhandled 'error' on the caller's stream.
        setImmediate(removeListeners)
        reject(err)
      } else {
        // Remove synchronously on success. A tight `await drainAwareWrite(...)` loop
        // against a stream whose write callback completes on the same tick would
        // otherwise stack up listeners faster than a deferred removal can clear
        // them and trip MaxListenersExceededWarning.
        removeListeners()
        resolve()
      }
    }

    const onError = (err: Error) => settle(err)
    const onDrain = () => settle()
    const onClose = () => settle(new Error('Stream closed before drainAwareWrite completed'))

    stream.once('error', onError)
    stream.once('close', onClose)

    canContinue = stream.write(data, (err) => {
      if (err) {
        settle(err)
      } else if (canContinue) {
        settle()
      }
    })

    if (!canContinue) {
      stream.once('drain', onDrain)
    }
  })
}
