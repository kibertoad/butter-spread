import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fastify } from 'fastify'
// @ts-expect-error
import nlp from 'node-nlp'
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest'
import { executeMixedChunksSequentially } from '../src/butterSpread'
import { defaultLogger } from '../src/logger'
import { splitTextPreserveWords } from '../src/stringUtils'

let stemmer: any
let sumTimeTaken: number
let executionCounter: number
const syncProcessor = (param: string) => {
  const start = Date.now()
  const result = stemmer.tokenizeAndStem(param)
  sumTimeTaken += Date.now() - start
  executionCounter++
  return result
}

const text = readFileSync(resolve(__dirname, 'test.txt')).toString()
const largeTextRaw = readFileSync(resolve(__dirname, 'largeTest.txt')).toString()
const largeText = largeTextRaw + largeTextRaw + largeTextRaw + largeTextRaw + largeTextRaw
const languageCode = 'en'

describe('executeMixedChunksSequentially', () => {
  let manager: any
  beforeEach(() => {
    manager = new nlp.NlpManager({ languages: [languageCode] })
    stemmer = manager.container.get(`stemmer-${languageCode}`)
  })

  afterEach(() => {
    vitest.restoreAllMocks()
  })

  it('returns empty output for empty input', async () => {
    const results = await executeMixedChunksSequentially([], syncProcessor, {
      id: 'someId',
    })

    expect(results).toEqual([])
  })

  it('processes all-sync processor correctly', async () => {
    sumTimeTaken = 0
    executionCounter = 0
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitTextPreserveWords(text, 1000)

    const results = await executeMixedChunksSequentially(chunks, syncProcessor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    expect(results).toMatchSnapshot()
    expect(loggingSpy.mock.calls.length).toBe(0)
  })

  it('processes all-async processor correctly', async () => {
    const asyncProcessor = (param: string) => {
      return Promise.resolve(stemmer.tokenizeAndStem(param))
    }

    const chunks = splitTextPreserveWords(text, 1000)

    const results = await executeMixedChunksSequentially(chunks, asyncProcessor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    expect(results).toMatchSnapshot()
  })

  it('processes mixed sync/async processor in correct order', async () => {
    let callIndex = 0
    const mixedProcessor = (param: string) => {
      const idx = callIndex++
      const result = stemmer.tokenizeAndStem(param)
      // Every other chunk is async
      if (idx % 2 === 1) {
        return Promise.resolve(result)
      }
      return result
    }

    const chunks = splitTextPreserveWords(text, 1000)

    const results = await executeMixedChunksSequentially(chunks, mixedProcessor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    // Compare with pure sync results to verify order is preserved
    const syncResults = chunks.map((c) => stemmer.tokenizeAndStem(c))
    expect(results).toEqual(syncResults)
  })

  it('does not block event loop with sync chunks', async () => {
    sumTimeTaken = 0
    executionCounter = 0
    const app = fastify()
    app.route({
      method: 'GET',
      url: '/',
      handler: (_req, res) => {
        return res.send({})
      },
    })

    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitTextPreserveWords(largeText, 50000)

    const startTime = Date.now()
    const resultsPromise = executeMixedChunksSequentially(chunks, syncProcessor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    await vitest.waitUntil(() => {
      return executionCounter > 0
    })
    const response = await app.inject().get('/')
    expect(response.statusCode).toBe(200)
    const timeTaken = Date.now() - startTime

    await resultsPromise
    // check that request was processed before all of the operation chunks were completed
    expect(sumTimeTaken > timeTaken).toBe(true)

    expect(loggingSpy.mock.calls.length).toBe(0)
    await app.close()
  })

  it('resets counters after async chunk (event loop stays responsive)', async () => {
    executionCounter = 0
    const app = fastify()
    app.route({
      method: 'GET',
      url: '/',
      handler: (_req, res) => {
        return res.send({})
      },
    })

    // Processor that returns promises for every other chunk
    const mixedProcessor = (param: string) => {
      const result = stemmer.tokenizeAndStem(param)
      executionCounter++
      if (executionCounter % 2 === 0) {
        return Promise.resolve(result)
      }
      return result
    }

    const chunks = splitTextPreserveWords(largeText, 50000)

    const resultsPromise = executeMixedChunksSequentially(chunks, mixedProcessor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    await vitest.waitUntil(() => {
      return executionCounter > 0
    })
    // Event loop is responsive during mixed processing — HTTP request completes
    const response = await app.inject().get('/')
    expect(response.statusCode).toBe(200)

    const results = await resultsPromise
    expect(results.length).toBe(chunks.length)
    await app.close()
  })

  it('logs warning when threshold is exceeded with sync processor', async () => {
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitTextPreserveWords(text, 1000000000)

    let now = 0
    const dateNowSpy = vitest.spyOn(Date, 'now')
    dateNowSpy.mockImplementation(() => {
      // Each call advances time by 100ms, guaranteeing threshold is exceeded
      return (now += 100)
    })

    await executeMixedChunksSequentially(chunks, syncProcessor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 1,
    })

    expect(loggingSpy.mock.calls.length).toBe(1)
    expect(loggingSpy.mock.calls[0][0]).toMatch(
      /^Execution "Stemming" has exceeded the threshold, took (\d+) msecs for a single iteration. (\d+) chunks were processed. Last chunk took (\d+) msecs for (\d+) elements.$/,
    )
  })

  it('logs warning when threshold is exceeded with async processor', async () => {
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitTextPreserveWords(text, 1000000000)

    const asyncProcessor = (param: string) => {
      return Promise.resolve(stemmer.tokenizeAndStem(param))
    }

    let now = 0
    const dateNowSpy = vitest.spyOn(Date, 'now')
    dateNowSpy.mockImplementation(() => {
      // Each call advances time by 100ms, guaranteeing threshold is exceeded
      return (now += 100)
    })

    await executeMixedChunksSequentially(chunks, asyncProcessor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 1,
    })

    expect(loggingSpy.mock.calls.length).toBe(1)
    expect(loggingSpy.mock.calls[0][0]).toMatch(
      /^Execution "Stemming" has exceeded the threshold, took (\d+) msecs for a single iteration. (\d+) chunks were processed. Last chunk took (\d+) msecs for (\d+) elements.$/,
    )
  })

  it('throws an error if sync processor breaks', async () => {
    await expect(
      executeMixedChunksSequentially(
        ['a', 'b'],
        () => {
          throw new Error('It broke down')
        },
        {
          id: 'Stemming',
          logger: defaultLogger,
          warningThresholdInMsecs: 1,
        },
      ),
    ).rejects.toThrow(/It broke down/)
  })

  it('throws an error if async processor rejects', async () => {
    await expect(
      executeMixedChunksSequentially(
        ['a', 'b'],
        () => {
          return Promise.reject(new Error('Async failure'))
        },
        {
          id: 'Stemming',
          logger: defaultLogger,
          warningThresholdInMsecs: 1,
        },
      ),
    ).rejects.toThrow(/Async failure/)
  })
})
