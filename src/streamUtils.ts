import type { Writable } from 'node:stream'

export async function* batchFromStream<T>(
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

export function drainAwareWrite(stream: Writable, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      // Defer listener removal to allow Node.js to emit the 'error' event
      // that follows a failed write callback on the next tick
      setImmediate(() => {
        stream.removeListener('error', onError)
        stream.removeListener('drain', onDrain)
      })
    }

    const settle = (err?: Error | null) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }

    const onError = (err: Error) => settle(err)
    const onDrain = () => settle()

    stream.on('error', onError)

    const canContinue = stream.write(data, (err) => {
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
