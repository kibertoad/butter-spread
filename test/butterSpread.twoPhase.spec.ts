import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fastify } from 'fastify'
// @ts-expect-error
import nlp from 'node-nlp'
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest'
import { executeTwoPhaseChunksSequentially } from '../src/butterSpread'
import { defaultLogger } from '../src/logger'
import { splitTextPreserveWords } from '../src/stringUtils'

let stemmer: any
const text = readFileSync(resolve(__dirname, 'test.txt')).toString()
const largeTextRaw = readFileSync(resolve(__dirname, 'largeTest.txt')).toString()
const largeText = largeTextRaw + largeTextRaw + largeTextRaw + largeTextRaw + largeTextRaw
const languageCode = 'en'

describe('executeTwoPhaseChunksSequentially', () => {
  let manager: any
  beforeEach(() => {
    manager = new nlp.NlpManager({ languages: [languageCode] })
    stemmer = manager.container.get(`stemmer-${languageCode}`)
  })

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
    const chunks = splitTextPreserveWords(text, 1000)
    const batchSizes: number[] = []

    const results = await executeTwoPhaseChunksSequentially(
      chunks,
      {
        syncTransform: (param: string) => stemmer.tokenizeAndStem(param),
        asyncPostProcess: (batch: string[][]) => {
          batchSizes.push(batch.length)
          return Promise.resolve(batch)
        },
      },
      {
        id: 'TwoPhase',
        logger: defaultLogger,
        warningThresholdInMsecs: 50,
      },
    )

    expect(results).toMatchSnapshot()
    // All chunks were processed
    expect(results.length).toBe(chunks.length)
    // asyncPostProcess was called fewer times than total chunks (batching happened)
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(chunks.length)
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
    // All items processed in a single async call
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
    // Each chunk triggered its own flush
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
          await new Promise<void>((resolve) => setTimeout(resolve, callCount % 2 === 0 ? 10 : 1))
          return batch.map((n) => n + 1)
        },
      },
      {
        id: 'ordering',
        // Zero threshold forces individual flushes for predictable ordering test
        executeSynchronouslyThresholdInMsecs: 0,
      },
    )

    expect(results).toEqual([11, 21, 31, 41, 51, 61])
  })

  it('async phase resets thresholds (event loop stays responsive)', async () => {
    let executionCounter = 0
    const app = fastify()
    app.route({
      method: 'GET',
      url: '/',
      handler: (_req, res) => {
        return res.send({})
      },
    })

    const chunks = splitTextPreserveWords(largeText, 50000)

    const resultsPromise = executeTwoPhaseChunksSequentially(
      chunks,
      {
        syncTransform: (param: string) => {
          executionCounter++
          return stemmer.tokenizeAndStem(param)
        },
        asyncPostProcess: async (batch: string[][]) => {
          // Simulate async I/O (e.g. bulk DB insert)
          await new Promise<void>((resolve) => setImmediate(resolve))
          return batch
        },
      },
      {
        id: 'TwoPhase',
        logger: defaultLogger,
        warningThresholdInMsecs: 50,
      },
    )

    await vitest.waitUntil(() => executionCounter > 0)
    const response = await app.inject().get('/')
    expect(response.statusCode).toBe(200)

    const results = await resultsPromise
    expect(results.length).toBe(chunks.length)
    await app.close()
  })

  it('logs warning when sync phase exceeds threshold', async () => {
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitTextPreserveWords(text, 1000000000)

    let now = 0
    const dateNowSpy = vitest.spyOn(Date, 'now')
    dateNowSpy.mockImplementation(() => {
      return (now += 100)
    })

    await executeTwoPhaseChunksSequentially(
      chunks,
      {
        syncTransform: (param: string) => stemmer.tokenizeAndStem(param),
        asyncPostProcess: async (batch: string[][]) => batch,
      },
      {
        id: 'TwoPhase',
        logger: defaultLogger,
        warningThresholdInMsecs: 1,
      },
    )

    expect(loggingSpy.mock.calls.length).toBe(1)
    expect(loggingSpy.mock.calls[0][0]).toMatch(/^Execution "TwoPhase" has exceeded the threshold/)
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
        { id: 'TwoPhase', logger: defaultLogger, warningThresholdInMsecs: 1 },
      ),
    ).rejects.toThrow(/Sync broke/)
  })

  it('throws an error if async post-process rejects', async () => {
    await expect(
      executeTwoPhaseChunksSequentially(
        ['a', 'b'],
        {
          syncTransform: (x: string) => x,
          asyncPostProcess: () => Promise.reject(new Error('Async broke')),
        },
        { id: 'TwoPhase', logger: defaultLogger, warningThresholdInMsecs: 1 },
      ),
    ).rejects.toThrow(/Async broke/)
  })
})
