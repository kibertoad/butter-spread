import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vitest } from 'vitest'
import { executeTwoPhaseChunksSequentially } from '../src/butterSpread'
import { cpuBurn, WARNING_MESSAGE } from './utils/cpuBurn'
import { spyLogger } from './utils/logger'
import { requestDuringWorkload } from './utils/responsiveness'

const items = (count: number) => Array.from({ length: count }, (_, i) => i)

describe('executeTwoPhaseChunksSequentially', () => {
  afterEach(() => {
    vitest.restoreAllMocks()
  })

  it('returns empty output for empty input', async () => {
    const results = await executeTwoPhaseChunksSequentially(
      [],
      {
        syncTransform: (x: string) => x,
        asyncPostProcess: async (batch) => batch,
      },
      { id: 'someId' },
    )

    expect(results).toEqual([])
  })

  it('processes sync transform then batched async post-process', async () => {
    const logger = spyLogger()
    const input = items(40)
    const batchSizes: number[] = []

    const results = await executeTwoPhaseChunksSequentially(
      input,
      {
        syncTransform: (n: number) => {
          cpuBurn(1)
          return n * 10
        },
        asyncPostProcess: (batch: number[]) => {
          batchSizes.push(batch.length)
          return Promise.resolve(batch)
        },
      },
      { id: 'TwoPhase', logger, warningThresholdInMsecs: 50 },
    )

    expect(results).toEqual(input.map((n) => n * 10))
    // ~40ms of sync work against a 15ms threshold: several flushes, fewer than chunks
    expect(batchSizes.length).toBeGreaterThan(1)
    expect(batchSizes.length).toBeLessThan(input.length)
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(input.length)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('batches multiple sync transforms before flushing to async', async () => {
    const input = [1, 2, 3, 4, 5]
    const batchSizes: number[] = []

    const results = await executeTwoPhaseChunksSequentially(
      input,
      {
        syncTransform: (n: number) => n * 10,
        asyncPostProcess: (batch: number[]) => {
          batchSizes.push(batch.length)
          return Promise.resolve(batch.map((n) => n + 1))
        },
      },
      {
        id: 'batching',
        // High threshold ensures all sync transforms run in one batch
        executeSynchronouslyThresholdInMsecs: 10000,
      },
    )

    expect(results).toEqual([11, 21, 31, 41, 51])
    expect(batchSizes).toEqual([5])
  })

  it('flushes to async when sync threshold is exceeded', async () => {
    const input = [1, 2, 3, 4]
    const batchSizes: number[] = []

    const results = await executeTwoPhaseChunksSequentially(
      input,
      {
        syncTransform: (n: number) => n * 10,
        asyncPostProcess: (batch: number[]) => {
          batchSizes.push(batch.length)
          return Promise.resolve(batch)
        },
      },
      {
        id: 'flush-test',
        // Zero threshold: flush after every sync transform
        executeSynchronouslyThresholdInMsecs: 0,
      },
    )

    expect(results).toEqual([10, 20, 30, 40])
    expect(batchSizes).toEqual([1, 1, 1, 1])
  })

  it('preserves result order across batched flushes', async () => {
    const input = [1, 2, 3, 4, 5, 6]
    let callCount = 0

    const results = await executeTwoPhaseChunksSequentially(
      input,
      {
        syncTransform: (n: number) => n * 10,
        asyncPostProcess: async (batch: number[]) => {
          callCount++
          // Simulate varying async delays per batch
          await sleep(callCount % 2 === 0 ? 10 : 1)
          return batch.map((n) => n + 1)
        },
      },
      { id: 'ordering', executeSynchronouslyThresholdInMsecs: 0 },
    )

    expect(results).toEqual([11, 21, 31, 41, 51, 61])
  })

  it('async phase resets thresholds (event loop stays responsive)', async () => {
    let calls = 0
    const input = items(100)

    const resultsPromise = executeTwoPhaseChunksSequentially(
      input,
      {
        syncTransform: (n: number) => {
          calls++
          cpuBurn(2)
          return n
        },
        asyncPostProcess: async (batch: number[]) => {
          // Simulate async I/O (e.g. bulk DB insert)
          await new Promise<void>((resolve) => setImmediate(resolve))
          return batch
        },
      },
      { id: 'TwoPhase', warningThresholdInMsecs: 50 },
    )
    const progressAtResponse = await requestDuringWorkload(
      () => calls > 0,
      () => calls,
    )

    const results = await resultsPromise
    expect(results).toEqual(input)
    expect(progressAtResponse).toBeLessThan(input.length)
  })

  it('stays responsive when asyncPostProcess resolves without scheduling a task', async () => {
    // An identity post-process resolves on the microtask queue, so `await` alone
    // never hands control back to timers or I/O. The executor has to yield itself.
    let calls = 0
    const input = items(100)

    const resultsPromise = executeTwoPhaseChunksSequentially(
      input,
      {
        syncTransform: (n: number) => {
          calls++
          cpuBurn(2)
          return n
        },
        asyncPostProcess: async (batch: number[]) => batch,
      },
      { id: 'TwoPhaseImmediate', executeSynchronouslyThresholdInMsecs: 0 },
    )

    const progressAtResponse = await requestDuringWorkload(
      () => calls > 0,
      () => calls,
    )

    const results = await resultsPromise
    expect(results).toEqual(input)
    expect(progressAtResponse).toBeLessThan(input.length)
  })

  it('logs warning when sync phase exceeds threshold', async () => {
    const logger = spyLogger()

    await executeTwoPhaseChunksSequentially(
      ['a'],
      {
        syncTransform: () => cpuBurn(5),
        asyncPostProcess: async (batch) => batch,
      },
      { id: 'TwoPhase', logger, warningThresholdInMsecs: 1 },
    )

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toMatch(WARNING_MESSAGE)
  })

  it('does not count asyncPostProcess time towards the warning threshold', async () => {
    const logger = spyLogger()

    await executeTwoPhaseChunksSequentially(
      items(3),
      {
        syncTransform: (n: number) => n,
        asyncPostProcess: async (batch) => {
          await sleep(20)
          return batch
        },
      },
      { id: 'TwoPhase', logger, warningThresholdInMsecs: 5 },
    )

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('throws an error if sync transform breaks', async () => {
    await expect(
      executeTwoPhaseChunksSequentially(
        ['a', 'b'],
        {
          syncTransform: () => {
            throw new Error('Sync broke')
          },
          asyncPostProcess: async (batch) => batch,
        },
        { id: 'TwoPhase', warningThresholdInMsecs: 1 },
      ),
    ).rejects.toThrow(/Sync broke/)
  })

  it('handles asyncPostProcess returning a batch larger than V8 spread limit', async () => {
    // V8's argument-count limit (~65535) would cause `results.push(...batchResults)`
    // to throw RangeError. Regression test for the indexed-push fix.
    const LARGE_SIZE = 70_000
    const results = await executeTwoPhaseChunksSequentially(
      [1],
      {
        syncTransform: (n: number) => n,
        asyncPostProcess: async () => Array.from({ length: LARGE_SIZE }, (_, i) => i),
      },
      { id: 'large-batch' },
    )

    expect(results.length).toBe(LARGE_SIZE)
    expect(results[0]).toBe(0)
    expect(results[LARGE_SIZE - 1]).toBe(LARGE_SIZE - 1)
  })

  it('throws an error if async post-process rejects', async () => {
    await expect(
      executeTwoPhaseChunksSequentially(
        ['a', 'b'],
        {
          syncTransform: (x: string) => x,
          asyncPostProcess: () => Promise.reject(new Error('Async broke')),
        },
        { id: 'TwoPhase', warningThresholdInMsecs: 1 },
      ),
    ).rejects.toThrow(/Async broke/)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an object', { rows: [] }],
  ])('throws a descriptive TypeError if asyncPostProcess resolves to %s', async (_label, value) => {
    await expect(
      executeTwoPhaseChunksSequentially(
        ['a'],
        {
          syncTransform: (x: string) => x,
          // Simulates a forgotten `return` (or returning the wrong shape)
          asyncPostProcess: async () => value as unknown as string[],
        },
        { id: 'TwoPhase' },
      ),
    ).rejects.toThrow(/Execution "TwoPhase": asyncPostProcess must resolve to an array/)
  })

  it('rejects invalid threshold options', async () => {
    await expect(
      executeTwoPhaseChunksSequentially(
        [1],
        { syncTransform: (x: number) => x, asyncPostProcess: async (batch) => batch },
        { id: 'invalid', warningThresholdInMsecs: -1 },
      ),
    ).rejects.toThrow(RangeError)
  })
})
