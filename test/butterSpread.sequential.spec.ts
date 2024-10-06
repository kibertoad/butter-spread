import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fastify } from 'fastify'
// @ts-ignore
import nlp from 'node-nlp'
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest'
import { executeSyncChunksSequentially } from '../src/butterSpread'
import { defaultLogger } from '../src/logger'
import { splitTextPreserveWords } from '../src/stringUtils'

let stemmer: any
let sumTimeTaken: number
let executionCounter: number
const processor = (param: string) => {
  console.log('start processing an entry')
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

describe('butterSpread', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let manager: any
  beforeEach(() => {
    manager = new nlp.NlpManager({ languages: [languageCode] })
    stemmer = manager.container.get(`stemmer-${languageCode}`)
  })

  afterEach(() => {})

  it('does not log warning when threshold is not exceeded', async () => {
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitTextPreserveWords(text, 1000)

    const results = await executeSyncChunksSequentially(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    expect(results).toMatchSnapshot()
    expect(loggingSpy.mock.calls.length).toBe(0)
  })

  it('returns empty output for empty input', async () => {
    const results = await executeSyncChunksSequentially([], processor, {
      id: 'someId',
    })

    expect(results).toEqual([])
  })

  it('does not block event loop', async () => {
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
    const resultsPromise = executeSyncChunksSequentially(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    await vitest.waitUntil(() => {
      return executionCounter > 0
    })
    const response = await app.inject().get('/')
    console.log('received response')
    expect(response.statusCode).toBe(200)
    const timeTaken = Date.now() - startTime

    await resultsPromise
    // check that request was processed before all of the operation chunks were completed
    expect(sumTimeTaken > timeTaken).toBe(true)

    expect(loggingSpy.mock.calls.length).toBe(0)
    await app.close()
  })

  it('processes synchronously within a given timeframe', async () => {
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
    const resultsPromise = executeSyncChunksSequentially(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 1000,
      executeSynchronouslyThresholdInMsecs: 500,
    })

    await vitest.waitUntil(() => {
      return executionCounter > 0
    })
    const response = await app.inject().get('/')
    console.log('received response')
    expect(response.statusCode).toBe(200)
    const timeTaken = Date.now() - startTime

    await resultsPromise
    // check that request was processed before all of the operation chunks were completed
    expect(sumTimeTaken > timeTaken).toBe(false)

    expect(loggingSpy.mock.calls.length).toBe(0)
    await app.close()
  })

  it('logs warning when threshold is exceeded', async () => {
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitTextPreserveWords(text, 1000000000)

    await executeSyncChunksSequentially(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 1,
    })

    expect(loggingSpy.mock.calls.length).toBe(1)
    expect(loggingSpy.mock.calls[0][0]).toMatch(
      /^Execution "Stemming" has exceeded the threshold, took (\d+) msecs for a single iteration. (\d+) chunks were processed. Last chunk took (\d+) msecs for (\d+) elements.$/,
    )
  })

  it('throws an error if something breaks', async () => {
    await expect(
      executeSyncChunksSequentially(
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
})
