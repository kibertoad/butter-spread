import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { batchFromStream, drainAwareWrite } from '../src/streamUtils'

describe('batchFromStream', () => {
  it('batches items from async iterable', async () => {
    function* generate() {
      for (let i = 1; i <= 7; i++) {
        yield i
      }
    }

    const batches: number[][] = []
    for await (const batch of batchFromStream(generate(), 3)) {
      batches.push(batch)
    }

    expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7]])
  })

  it('returns single batch when items fewer than batch size', async () => {
    function* generate() {
      yield 'a'
      yield 'b'
    }

    const batches: string[][] = []
    for await (const batch of batchFromStream(generate(), 10)) {
      batches.push(batch)
    }

    expect(batches).toEqual([['a', 'b']])
  })

  it('yields nothing for empty source', async () => {
    async function* generate(): AsyncGenerator<number> {
      // empty
    }

    const batches: number[][] = []
    for await (const batch of batchFromStream(generate(), 5)) {
      batches.push(batch)
    }

    expect(batches).toEqual([])
  })

  it('handles exact multiple of batch size', async () => {
    function* generate() {
      for (let i = 1; i <= 6; i++) {
        yield i
      }
    }

    const batches: number[][] = []
    for await (const batch of batchFromStream(generate(), 3)) {
      batches.push(batch)
    }

    expect(batches).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
  })

  it('propagates errors from source', async () => {
    function* generate() {
      yield 1
      yield 2
      throw new Error('Source failed')
    }

    const batches: number[][] = []
    await expect(async () => {
      for await (const batch of batchFromStream(generate(), 5)) {
        batches.push(batch)
      }
    }).rejects.toThrow(/Source failed/)

    // No complete batch was yielded (batch size 5, only 2 items before error)
    expect(batches).toEqual([])
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('throws synchronously for %s batchSize', (_label, batchSize) => {
    function* generate() {
      yield 1
    }

    expect(() => batchFromStream(generate(), batchSize)).toThrow(RangeError)
  })

  it('works with a Node.js readable stream', async () => {
    const passThrough = new PassThrough({ objectMode: true })

    // Push items and end
    passThrough.write(1)
    passThrough.write(2)
    passThrough.write(3)
    passThrough.write(4)
    passThrough.write(5)
    passThrough.end()

    const batches: number[][] = []
    for await (const batch of batchFromStream(passThrough, 2)) {
      batches.push(batch)
    }

    expect(batches).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('drainAwareWrite', () => {
  it('writes data to stream', async () => {
    const chunks: Buffer[] = []
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk)
        callback()
      },
    })

    await drainAwareWrite(writable, 'hello')
    await drainAwareWrite(writable, ' world')

    expect(Buffer.concat(chunks).toString()).toBe('hello world')
  })

  it('waits for drain when backpressure is applied', async () => {
    // Create a writable with very small highWaterMark to trigger backpressure
    const chunks: Buffer[] = []
    const writable = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(chunk)
        // Simulate slow consumer
        setTimeout(callback, 10)
      },
    })

    const largeData = 'x'.repeat(100)
    await drainAwareWrite(writable, largeData)

    expect(Buffer.concat(chunks).toString()).toBe(largeData)
  })

  it('removes its listeners as soon as a write succeeds', async () => {
    // A PassThrough completes write callbacks on the same tick. Twenty awaited writes
    // in a row used to stack twenty 'error'/'close' listeners (removal was deferred
    // with setImmediate) and trip MaxListenersExceededWarning at the eleventh.
    const sink = new PassThrough()
    sink.resume()

    for (let i = 0; i < 20; i++) {
      await drainAwareWrite(sink, `line-${i}\n`)
    }

    expect(sink.listenerCount('error')).toBe(0)
    expect(sink.listenerCount('close')).toBe(0)
    expect(sink.listenerCount('drain')).toBe(0)
  })

  it('removes its listeners after waiting for drain', async () => {
    const writable = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(callback, 5)
      },
    })

    await drainAwareWrite(writable, 'x'.repeat(100))

    expect(writable.listenerCount('error')).toBe(0)
    expect(writable.listenerCount('close')).toBe(0)
    expect(writable.listenerCount('drain')).toBe(0)
  })

  it('still handles the trailing error event Node emits after a failed write callback', async () => {
    // After a failed write callback Node destroys the stream and emits 'error' on the
    // next tick. drainAwareWrite defers removing its listener on the error path so that
    // event is handled; had the listener been removed synchronously, the emit would
    // surface as an uncaught exception and fail this run.
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('Write failed'))
      },
    })

    await expect(drainAwareWrite(writable, 'data')).rejects.toThrow(/Write failed/)

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(writable.errored).toBeInstanceOf(Error)
    expect(writable.listenerCount('error')).toBe(0)
    expect(writable.listenerCount('close')).toBe(0)
  })

  it('rejects when writing to a destroyed stream', async () => {
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })

    writable.destroy()

    await expect(drainAwareWrite(writable, 'data')).rejects.toThrow()
  })

  it('rejects on write error', async () => {
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('Write failed'))
      },
    })

    await expect(drainAwareWrite(writable, 'data')).rejects.toThrow(/Write failed/)
  })

  it('rejects when stream closes mid-write without emitting error', async () => {
    // Hold the write callback so the write stays "in flight", then emit 'close'
    // directly. The cb-error path and the 'error' listener are both bypassed —
    // only the 'close' safety net should settle the promise.
    const writable = new Writable({
      write(_chunk, _encoding, _callback) {
        // intentionally never invoke callback
      },
    })

    const writePromise = drainAwareWrite(writable, 'data')

    await new Promise<void>((resolve) => setImmediate(resolve))
    writable.emit('close')

    await expect(writePromise).rejects.toThrow(/Stream closed/)
  })
})
