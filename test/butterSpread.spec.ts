import { executeSyncChunks } from '../src/butterSpread'
import { PorterStemmer } from 'natural'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { splitString } from '../src/arrayUtils'
import { vitest } from 'vitest'
import { defaultLogger } from '../src/logger'
import { fastify } from 'fastify'

let sumTimeTaken: number
const processor = (param: string) => {
  const start = Date.now()
  const result = PorterStemmer.stem(param)
  sumTimeTaken += Date.now() - start

  return result
}
const text = readFileSync(resolve(__dirname, 'test.txt')).toString()

describe('butterSpread', () => {
  it('does not log warning when threshold is not exceeded', async () => {
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitString(text, 1000)

    const results = await executeSyncChunks(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    expect(results).toMatchSnapshot()
    expect(loggingSpy.mock.calls.length).toBe(0)
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
    const chunks = splitString(text, 1000)

    const startTime = Date.now()
    const resultsPromise = executeSyncChunks(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 50,
    })

    const response = await app.inject().get('/')
    console.log('Received response!')
    expect(response.statusCode).toBe(200)
    const timeTaken = Date.now() - startTime

    await resultsPromise
    // check that request was processed before all of the operation chunks were completed
    expect(sumTimeTaken > timeTaken).toBe(true)

    expect(loggingSpy.mock.calls.length).toBe(0)
  })

  it('logs warning when threshold is exceeded', async () => {
    const loggingSpy = vitest.spyOn(console, 'warn')
    const chunks = splitString(text, 1000000000)

    await executeSyncChunks(chunks, processor, {
      id: 'Stemming',
      logger: defaultLogger,
      warningThresholdInMsecs: 1,
    })

    expect(loggingSpy.mock.calls.length).toBe(1)
    expect(loggingSpy.mock.calls[0][0]).toMatch(
      /^Execution "Stemming" has exceeded the threshold, took (\d+) msecs for a single iteration, processing 1 elements\.$/,
    )
  })
})
