import { afterEach, describe, expect, it, vitest } from 'vitest'
import { executeSyncChunksSequentially } from '../src/butterSpread'
import { burningProcessor, cpuBurn, WARNING_MESSAGE } from './utils/cpuBurn'
import { spyLogger } from './utils/logger'
import { requestDuringWorkload } from './utils/responsiveness'

const items = (count: number) => Array.from({ length: count }, (_, i) => i)

describe('executeSyncChunksSequentially', () => {
  afterEach(() => {
    vitest.restoreAllMocks()
  })

  it('returns results in input order without warnings when threshold is not exceeded', async () => {
    const logger = spyLogger()
    const { processor } = burningProcessor(1)

    const results = await executeSyncChunksSequentially(items(20), processor, {
      id: 'Burn',
      logger,
      warningThresholdInMsecs: 50,
    })

    expect(results).toEqual(items(20).map((i) => `processed-${i}`))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('returns empty output for empty input', async () => {
    const results = await executeSyncChunksSequentially([], burningProcessor(1).processor, {
      id: 'someId',
    })

    expect(results).toEqual([])
  })

  it('does not block event loop', async () => {
    const { processor, calls } = burningProcessor(2)
    const input = items(100)

    const resultsPromise = executeSyncChunksSequentially(input, processor, {
      id: 'Burn',
      warningThresholdInMsecs: 50,
    })
    const progressAtResponse = await requestDuringWorkload(() => calls() > 0, calls)

    const results = await resultsPromise
    expect(results.length).toBe(input.length)
    // The request was served before the whole workload completed
    expect(progressAtResponse).toBeLessThan(input.length)
  })

  it('processes synchronously within a given timeframe', async () => {
    const { processor, calls } = burningProcessor(2)
    const input = items(50)

    const resultsPromise = executeSyncChunksSequentially(input, processor, {
      id: 'Burn',
      warningThresholdInMsecs: 1000,
      executeSynchronouslyThresholdInMsecs: 500,
    })
    const progressAtResponse = await requestDuringWorkload(() => calls() > 0, calls)

    await resultsPromise
    // The whole workload (~100ms) fits inside the 500ms sync window, so no yield
    // happened and the request could only be served once everything was done
    expect(progressAtResponse).toBe(input.length)
  })

  it('logs warning when threshold is exceeded', async () => {
    const logger = spyLogger()

    await executeSyncChunksSequentially([[1, 2, 3]], () => cpuBurn(5), {
      id: 'Burn',
      logger,
      warningThresholdInMsecs: 1,
    })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    const message = logger.warn.mock.calls[0][0] as string
    expect(message).toMatch(WARNING_MESSAGE)
    expect(message).toContain('Execution "Burn"')
    expect(message).toContain('1 chunks were processed')
    expect(message).toContain('for 3 elements')
  })

  it('falls back to console.warn when no logger is provided', async () => {
    const consoleSpy = vitest.spyOn(console, 'warn').mockImplementation(() => {})

    await executeSyncChunksSequentially([1], () => cpuBurn(5), {
      id: 'Burn',
      warningThresholdInMsecs: 1,
    })

    expect(consoleSpy).toHaveBeenCalledTimes(1)
    expect(consoleSpy.mock.calls[0][0]).toMatch(WARNING_MESSAGE)
  })

  it('emits at most one warning per synchronous burst', async () => {
    const logger = spyLogger()

    await executeSyncChunksSequentially(items(5), () => cpuBurn(2), {
      id: 'Burn',
      logger,
      warningThresholdInMsecs: 1,
      // No yield happens, so all five chunks form a single burst
      executeSynchronouslyThresholdInMsecs: 10_000,
    })

    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('resets the warning latch after yielding', async () => {
    const logger = spyLogger()

    await executeSyncChunksSequentially(items(3), () => cpuBurn(2), {
      id: 'Burn',
      logger,
      warningThresholdInMsecs: 1,
      // Yield after every chunk, so each chunk is its own burst
      executeSynchronouslyThresholdInMsecs: 0,
    })

    expect(logger.warn).toHaveBeenCalledTimes(3)
  })

  it('disables warnings when warningThresholdInMsecs is 0', async () => {
    const logger = spyLogger()

    await executeSyncChunksSequentially([1], () => cpuBurn(5), {
      id: 'Burn',
      logger,
      warningThresholdInMsecs: 0,
    })

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('throws an error if something breaks', async () => {
    await expect(
      executeSyncChunksSequentially(
        ['a', 'b'],
        () => {
          throw new Error('It broke down')
        },
        { id: 'Burn', warningThresholdInMsecs: 1 },
      ),
    ).rejects.toThrow(/It broke down/)
  })

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s executeSynchronouslyThresholdInMsecs', async (_label, value) => {
    await expect(
      executeSyncChunksSequentially([1], (x) => x, {
        id: 'invalid',
        executeSynchronouslyThresholdInMsecs: value,
      }),
    ).rejects.toThrow(RangeError)
  })

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s warningThresholdInMsecs', async (_label, value) => {
    await expect(
      executeSyncChunksSequentially([1], (x) => x, {
        id: 'invalid',
        warningThresholdInMsecs: value,
      }),
    ).rejects.toThrow(/warningThresholdInMsecs must be a finite, non-negative number/)
  })

  it('validates options even for empty input', async () => {
    await expect(
      executeSyncChunksSequentially([], (x) => x, {
        id: 'invalid',
        executeSynchronouslyThresholdInMsecs: -5,
      }),
    ).rejects.toThrow(RangeError)
  })
})
