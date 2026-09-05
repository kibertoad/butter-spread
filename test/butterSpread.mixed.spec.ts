import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vitest } from 'vitest'
import { executeMixedChunksSequentially } from '../src/butterSpread'
import { burningProcessor, cpuBurn, WARNING_MESSAGE } from './utils/cpuBurn'
import { spyLogger } from './utils/logger'
import { requestDuringWorkload } from './utils/responsiveness'

const items = (count: number) => Array.from({ length: count }, (_, i) => i)

describe('executeMixedChunksSequentially', () => {
  afterEach(() => {
    vitest.restoreAllMocks()
  })

  it('returns empty output for empty input', async () => {
    const results = await executeMixedChunksSequentially([], burningProcessor(1).processor, {
      id: 'someId',
    })

    expect(results).toEqual([])
  })

  it('processes all-sync processor correctly', async () => {
    const logger = spyLogger()
    const { processor } = burningProcessor(1)

    const results = await executeMixedChunksSequentially(items(20), processor, {
      id: 'Mixed',
      logger,
      warningThresholdInMsecs: 50,
    })

    expect(results).toEqual(items(20).map((i) => `processed-${i}`))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('processes all-async processor correctly', async () => {
    const results = await executeMixedChunksSequentially(
      items(20),
      (chunk) => Promise.resolve(`processed-${chunk}`),
      { id: 'Mixed', warningThresholdInMsecs: 50 },
    )

    expect(results).toEqual(items(20).map((i) => `processed-${i}`))
  })

  it('processes mixed sync/async processor in correct order', async () => {
    const results = await executeMixedChunksSequentially(
      items(20),
      (chunk) => {
        cpuBurn(1)
        // Every other chunk is async, with varying latency
        if (chunk % 2 === 1) {
          return sleep(chunk % 4 === 1 ? 5 : 1, `processed-${chunk}`)
        }
        return `processed-${chunk}`
      },
      { id: 'Mixed', warningThresholdInMsecs: 50 },
    )

    expect(results).toEqual(items(20).map((i) => `processed-${i}`))
  })

  it('does not block event loop with sync chunks', async () => {
    const { processor, calls } = burningProcessor(2)
    const input = items(100)

    const resultsPromise = executeMixedChunksSequentially(input, processor, {
      id: 'Mixed',
      warningThresholdInMsecs: 50,
    })
    const progressAtResponse = await requestDuringWorkload(() => calls() > 0, calls)

    const results = await resultsPromise
    expect(results.length).toBe(input.length)
    expect(progressAtResponse).toBeLessThan(input.length)
  })

  it('does not block event loop when processor returns already-settled promises', async () => {
    // `await Promise.resolve(x)` only takes a microtask turn and never lets I/O run.
    // The executor must not treat that await as a yield: sync time still accumulates
    // and forces a real setImmediate yield once the threshold is reached.
    let calls = 0
    const input = items(100)

    const resultsPromise = executeMixedChunksSequentially(
      input,
      (chunk) => {
        calls++
        cpuBurn(2)
        return Promise.resolve(`processed-${chunk}`)
      },
      { id: 'Mixed', warningThresholdInMsecs: 50 },
    )
    const progressAtResponse = await requestDuringWorkload(
      () => calls > 0,
      () => calls,
    )

    const results = await resultsPromise
    expect(results).toEqual(input.map((i) => `processed-${i}`))
    expect(progressAtResponse).toBeLessThan(input.length)
  })

  it('does not count time spent awaiting async results towards the thresholds', async () => {
    const logger = spyLogger()

    await executeMixedChunksSequentially(items(5), () => sleep(20, 'x'), {
      id: 'Mixed',
      logger,
      // Each chunk waits 20ms on I/O but does no sync work, so no warning is due
      warningThresholdInMsecs: 5,
    })

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs warning when threshold is exceeded with sync processor', async () => {
    const logger = spyLogger()

    await executeMixedChunksSequentially(['a'], () => cpuBurn(5), {
      id: 'Mixed',
      logger,
      warningThresholdInMsecs: 1,
    })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toMatch(WARNING_MESSAGE)
  })

  it('logs warning for the synchronous part of an async processor', async () => {
    const logger = spyLogger()

    await executeMixedChunksSequentially(
      ['a'],
      () => {
        cpuBurn(5)
        return Promise.resolve('x')
      },
      { id: 'Mixed', logger, warningThresholdInMsecs: 1 },
    )

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toMatch(WARNING_MESSAGE)
  })

  it('throws an error if sync processor breaks', async () => {
    await expect(
      executeMixedChunksSequentially(
        ['a', 'b'],
        () => {
          throw new Error('It broke down')
        },
        { id: 'Mixed', warningThresholdInMsecs: 1 },
      ),
    ).rejects.toThrow(/It broke down/)
  })

  it('throws an error if async processor rejects', async () => {
    await expect(
      executeMixedChunksSequentially(['a', 'b'], () => Promise.reject(new Error('Async failure')), {
        id: 'Mixed',
        warningThresholdInMsecs: 1,
      }),
    ).rejects.toThrow(/Async failure/)
  })

  it('propagates rejections from custom thenables', async () => {
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: a thenable is exactly what this test exercises
      then(_resolve: (value: string) => void, reject: (reason: Error) => void) {
        reject(new Error('custom thenable'))
      },
    }

    await expect(
      executeMixedChunksSequentially([1], () => thenable as unknown as Promise<string>, {
        id: 'Mixed',
      }),
    ).rejects.toThrow(/custom thenable/)
  })

  it('rejects invalid threshold options', async () => {
    await expect(
      executeMixedChunksSequentially([1], (x) => x, {
        id: 'invalid',
        executeSynchronouslyThresholdInMsecs: Number.NaN,
      }),
    ).rejects.toThrow(RangeError)
  })
})
