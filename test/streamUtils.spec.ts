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
})
