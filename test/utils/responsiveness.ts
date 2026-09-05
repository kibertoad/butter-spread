import { fastify } from 'fastify'
import { vitest } from 'vitest'

/**
 * Starts an in-process HTTP server, waits until `started()` reports that the
 * workload under test has begun, then injects one request and returns the value of
 * `progress()` observed at the moment the response arrived. Callers compare that
 * against the total amount of work to decide whether the event loop was able to
 * serve the request mid-workload (or, for the "run synchronously" case, only after
 * the workload finished).
 */
export async function requestDuringWorkload(
  started: () => boolean,
  progress: () => number,
): Promise<number> {
  const app = fastify()
  app.route({
    method: 'GET',
    url: '/',
    handler: (_req, res) => res.send({}),
  })
  try {
    await vitest.waitUntil(started, { timeout: 10_000, interval: 5 })
    const response = await app.inject().get('/')
    if (response.statusCode !== 200) {
      throw new Error(`Unexpected status ${response.statusCode}`)
    }
    return progress()
  } finally {
    await app.close()
  }
}
