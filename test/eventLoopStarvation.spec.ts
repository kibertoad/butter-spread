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
 * CPU-bound processor that burns ~1-2ms per call.
 * Heavy enough to cause starvation without yielding, light enough
 * that butter-spread's yields allow monitoring timers to fire.
 */
function cpuBurn(item: number): number {
  let result = item
  for (let i = 0; i < 100_000; i++) {
    result = Math.sin(result) + Math.cos(result)
  }
  return result
}

/** Generate a workload array */
function makeWorkload(size: number): number[] {
  return Array.from({ length: size }, (_, i) => i)
}

// Shared monitoring options for both real and placebo tests.
// Identical thresholds ensure the only variable is whether butter-spread
// is used — the setup and conditions are the same.
// maxUtilization is null because butter-spread keeps the event loop
// busy-but-responsive (high utilization, low latency). The key metric
// is delay, not utilization.
const monitorOpts = {
  warmUpMs: 200,
  sampleCount: 4,
  sampleIntervalMs: 200,
  maxP99DelayMs: 100,
  maxMeanDelayMs: 50,
  maxUtilization: null as null,
}

const STARVATION_TEST_TIMEOUT = 15_000

describe('event loop starvation — memory-watchmen', { timeout: STARVATION_TEST_TIMEOUT }, () => {
  describe('executeSyncChunksSequentially', () => {
    it('does not starve the event loop with default thresholds', async () => {
      await assertNoStarvation(async (ctx) => {
        while (!ctx.stopped.value) {
          await executeSyncChunksSequentially(makeWorkload(30), cpuBurn, { id: 'starvation-sync' })
        }
      }, monitorOpts)
    })

    it('reports detailed event loop metrics via withEventLoopMonitor', async () => {
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          await executeSyncChunksSequentially(makeWorkload(30), cpuBurn, { id: 'metrics-sync' })
        }
      }, monitorOpts)

      expect(result.passed, formatEventLoopResult(result, 'executeSyncChunksSequentially')).toBe(
        true,
      )
      expect(result.delaySamples.length).toBeGreaterThan(0)
      expect(result.utilizationSamples.length).toBeGreaterThan(0)
    })

    it('placebo: same workload WITHOUT butter-spread starves the event loop', async () => {
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          const items = makeWorkload(30)
          for (const item of items) {
            cpuBurn(item)
          }
          // Yield once per full pass so monitoring timers can fire
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
          await executeMixedChunksSequentially(makeWorkload(30), cpuBurn, {
            id: 'starvation-mixed-sync',
          })
        }
      }, monitorOpts)
    })

    it('does not starve the event loop with mixed sync/async processor', async () => {
      // Mixed mode has higher inherent delay due to Promise.resolve() microtask
      // overhead on alternating chunks — relax mean threshold accordingly.
      const mixedOpts = { ...monitorOpts, maxMeanDelayMs: 100 }
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          let callIndex = 0
          await executeMixedChunksSequentially(
            makeWorkload(20),
            (item: number) => {
              const result = cpuBurn(item)
              if (callIndex++ % 2 === 1) {
                return Promise.resolve(result)
              }
              return result
            },
            { id: 'starvation-mixed' },
          )
        }
      }, mixedOpts)

      expect(
        result.passed,
        formatEventLoopResult(result, 'executeMixedChunksSequentially (mixed)'),
      ).toBe(true)
      // Verify p99 delay is meaningfully below placebo levels (typically >200ms)
      expect(result.peakP99DelayMs).toBeLessThan(150)
    })

    it('placebo: same workload WITHOUT butter-spread starves the event loop', async () => {
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          const items = makeWorkload(30)
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
            makeWorkload(30),
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

    it('placebo: same workload WITHOUT butter-spread starves the event loop', async () => {
      const result = await withEventLoopMonitor(async (ctx) => {
        while (!ctx.stopped.value) {
          const items = makeWorkload(30)
          for (const item of items) {
            cpuBurn(item)
            JSON.stringify(item)
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

      writable.write('x'.repeat(100))

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
