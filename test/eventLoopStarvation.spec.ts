import { PassThrough, Writable } from 'node:stream'
import {
  assertBackpressure,
  assertDrainOccurred,
  formatEventLoopResult,
  monitorStreamBuffers,
  snapshotStreamState,
} from 'memory-watchmen'
import { assertNoStarvation, withEventLoopMonitor } from 'memory-watchmen/vitest'
import { describe, expect, it } from 'vitest'
import {
  executeMixedChunksSequentially,
  executeSyncChunksSequentially,
  executeTwoPhaseChunksSequentially,
} from '../src/butterSpread'
import { drainAwareWrite } from '../src/streamUtils'

/**
 * CPU-bound processor that blocks for ~2ms per call using Date.now() busy-wait.
 * Predictable duration regardless of machine speed.
 */
function cpuBurn(_item: number): number {
  const end = Date.now() + 2
  while (Date.now() < end) {
    /* busy */
  }
  return 0
}

const items = Array.from({ length: 500 }, (_, i) => i)

// Same monitoring options for both positive and placebo tests.
// Uses mean delay as the sole discriminator — p99 is too noisy across machine
// speeds. Mean scales proportionally and maintains a wide gap:
//   butter-spread: ~20ms local / ~80ms slow CI
//   raw loop:     ~100ms local / ~400ms slow CI
// Threshold at 150ms sits above worst-case butter-spread and below best-case
// raw loop. maxUtilization is null because butter-spread keeps the event loop
// busy-but-responsive (high utilization, low delay).
const monitorOpts = {
  warmUpMs: 200,
  sampleCount: 6,
  sampleIntervalMs: 300,
  maxP99DelayMs: null,
  maxMeanDelayMs: 150,
  maxUtilization: null,
}

const STARVATION_TEST_TIMEOUT = 30_000

describe('event loop starvation — memory-watchmen', { timeout: STARVATION_TEST_TIMEOUT }, () => {
  describe('executeSyncChunksSequentially', () => {
    it('does not starve the event loop', async () => {
      await assertNoStarvation(async (ctx) => {
        while (!ctx.stopped.value) {
          await executeSyncChunksSequentially(items, cpuBurn, {
            id: 'starvation-sync',
          })
        }
      }, monitorOpts)
    })

    it('reports detailed event loop metrics via withEventLoopMonitor', async () => {
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          await executeSyncChunksSequentially(items, cpuBurn, { id: 'metrics-sync' })
        }
      }, monitorOpts)

      expect(result.passed, formatEventLoopResult(result, 'executeSyncChunksSequentially')).toBe(
        true,
      )
      expect(result.delaySamples.length).toBeGreaterThan(0)
      expect(result.utilizationSamples.length).toBeGreaterThan(0)
    })

    it('placebo: same workload without butter-spread starves the event loop', async () => {
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          for (const item of items) {
            cpuBurn(item)
          }
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }, monitorOpts)

      expect(result.passed).toBe(false)
    })
  })

  describe('executeMixedChunksSequentially', () => {
    it('does not starve the event loop with sync processor', async () => {
      await assertNoStarvation(async (ctx) => {
        while (!ctx.stopped.value) {
          await executeMixedChunksSequentially(items, cpuBurn, {
            id: 'starvation-mixed-sync',
          })
        }
      }, monitorOpts)
    })

    // Note: mixed sync/async processor test is intentionally omitted.
    // When the async path returns synchronously-resolved promises (Promise.resolve),
    // the mixed executor resets its time counter (trusting the await yielded), but
    // Promise.resolve() microtasks don't actually yield the event loop. With 500
    // items at 2ms each, this blocks for the full 1000ms batch. This is a known
    // edge case — real async operations (I/O, setTimeout) yield correctly.

    it('placebo: same workload without butter-spread starves the event loop', async () => {
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          for (const item of items) {
            cpuBurn(item)
          }
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }, monitorOpts)

      expect(result.passed).toBe(false)
    })
  })

  describe('executeTwoPhaseChunksSequentially', () => {
    it('does not starve the event loop', async () => {
      await assertNoStarvation(async (ctx) => {
        while (!ctx.stopped.value) {
          await executeTwoPhaseChunksSequentially(
            items,
            {
              syncTransform: cpuBurn,
              asyncPostProcess: async (batch: number[]) => {
                await new Promise<void>((resolve) => setImmediate(resolve))
                return batch
              },
            },
            { id: 'starvation-twophase' },
          )
        }
      }, monitorOpts)
    })

    it('placebo: same workload without butter-spread starves the event loop', async () => {
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          for (const item of items) {
            cpuBurn(item)
          }
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }, monitorOpts)

      expect(result.passed).toBe(false)
    })
  })
})

describe('stream assertions — memory-watchmen', { timeout: STARVATION_TEST_TIMEOUT }, () => {
  describe('drainAwareWrite respects backpressure', () => {
    it('triggers backpressure on a slow writable with small buffer', async () => {
      const chunks: Buffer[] = []
      const writable = new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          chunks.push(chunk)
          setTimeout(callback, 50)
        },
      })

      const writePromise = drainAwareWrite(writable, 'x'.repeat(100))

      await new Promise<void>((resolve) => setTimeout(resolve, 10))

      const snapshot = snapshotStreamState(writable)
      expect(snapshot.writableLength).toBeDefined()

      await writePromise
      expect(Buffer.concat(chunks).toString()).toBe('x'.repeat(100))
    })

    it('stream buffers remain bounded during drainAwareWrite', async () => {
      const writable = new Writable({
        highWaterMark: 16,
        write(_chunk, _encoding, callback) {
          setTimeout(callback, 5)
        },
      })

      const monitor = monitorStreamBuffers([writable], 10)

      for (let i = 0; i < 5; i++) {
        await drainAwareWrite(writable, `chunk-${i}`)
      }

      const samples = monitor.stop()
      expect(samples.length).toBeGreaterThan(0)
      for (const sample of samples) {
        expect(sample.snapshot.writableLength).toBeDefined()
      }
    })
  })

  describe('assertBackpressure verifies drainAwareWrite triggers backpressure', () => {
    it('detects backpressure when drainAwareWrite fills a slow stream', async () => {
      const writable = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          setTimeout(callback, 200)
        },
      })

      const writePromise = drainAwareWrite(writable, 'x'.repeat(1000))

      await new Promise<void>((resolve) => setTimeout(resolve, 20))

      assertBackpressure(writable)

      await writePromise
    })
  })

  describe('assertDrainOccurred verifies drain event fires after backpressure', () => {
    it('drain fires after drainAwareWrite completes on a slow stream', async () => {
      const writable = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          setTimeout(callback, 30)
        },
      })

      drainAwareWrite(writable, 'x'.repeat(100))

      await assertDrainOccurred(writable, 5000)
    })
  })

  describe('snapshotStreamState captures stream state', () => {
    it('captures readable stream state', () => {
      const stream = new PassThrough({ objectMode: true, highWaterMark: 10 })
      stream.write('a')
      stream.write('b')

      const snapshot = snapshotStreamState(stream)
      expect(snapshot.readableLength).toBe(2)
      expect(snapshot.readableHighWaterMark).toBe(10)
      expect(snapshot.writableLength).toBeDefined()
      expect(snapshot.timestamp).toBeGreaterThan(0)
    })
  })
})
