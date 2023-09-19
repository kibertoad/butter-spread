import type { Logger } from './logger'
import { defaultLogger } from './logger'

export type SyncProcessor<InputChunk, OutputChunk> = (chunk: InputChunk) => OutputChunk

export type ExecutionOptions = {
  id: string
  warningThresholdInMsecs?: number
  logger: Logger
}

// Parallel
export function executeSyncChunks<InputChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: SyncProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions = {
    id: 'unnamed',
    logger: defaultLogger,
  },
): Promise<OutputChunk[]> {
  return new Promise((resolve, reject) => {
    let startTime: number
    const results: OutputChunk[] = []
    try {
      for (let chunk of inputChunks) {
        setImmediate(() => {
          if (options.warningThresholdInMsecs) {
            startTime = Date.now()
          }
          results.push(processor(chunk))
          if (options.warningThresholdInMsecs) {
            const timeTaken = Date.now() - startTime
            if (timeTaken >= options.warningThresholdInMsecs) {
              const length = Array.isArray(chunk) ? chunk.length : 1
              options.logger.warn(
                `Execution "${options.id}" has exceeded the threshold, took ${timeTaken} msecs for a single iteration, processing ${length} elements.`,
              )
            }
          }

          if (results.length === inputChunks.length) {
            console.log('Finished processing!')
            resolve(results)
          }
        })
      }
    } catch (err) {
      reject(err)
    }
  })
}
