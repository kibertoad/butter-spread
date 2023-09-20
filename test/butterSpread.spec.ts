import { executeSyncChunksSequentially } from '../src/butterSpread'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { splitString } from '../src/arrayUtils'
import { vitest } from 'vitest'
import { defaultLogger } from '../src/logger'
import { fastify } from 'fastify'
import nlp from 'node-nlp'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stemmer: any
let sumTimeTaken: number
const processor = (param: string) => {
  const start = Date.now()
  const result = stemmer.tokenizeAndStem(param)
  sumTimeTaken += Date.now() - start

  return result
}
const text = readFileSync(resolve(__dirname, 'test.txt')).toString()
const largeText = readFileSync(resolve(__dirname, 'largeTest.txt')).toString()
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
    const chunks = splitString(text, 1000)

    const results = await executeSyncChunksSequentially(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    expect(results).toMatchSnapshot()
    expect(loggingSpy.mock.calls.length).toBe(0)
  })

  it('returns empty output for empty input', async () => {
    const results = await executeSyncChunksSequentially([], processor)

    expect(results).toEqual([])
  })

  it('does not block event loop', async () => {
    sumTimeTaken = 0
    const app = fastify()
    app.route({
      method: 'GET',
      url: '/',
      handler: (req, res) => {
        return res.send({})
      },
    })

    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitString(largeText, 50000)

    const startTime = Date.now()
    const resultsPromise = executeSyncChunksSequentially(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
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

  it('logs warning when threshold is exceeded', async () => {
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitString(text, 1000000000)

    await executeSyncChunksSequentially(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 1,
    })

    expect(loggingSpy.mock.calls.length).toBe(1)
    expect(loggingSpy.mock.calls[0][0]).toMatch(
      /^Execution "Stemming" has exceeded the threshold, took (\d+) msecs for a single iteration, processing (\d+) elements\.$/,
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
