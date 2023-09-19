import type { Logger } from './logger'
import { defaultLogger } from './logger'

export type SyncProcessor<InputChunk, OutputChunk> = (chunk: InputChunk) => OutputChunk

export type ExecutionOptions = {
  id: string
  warningThresholdInMsecs?: number
  logger: Logger
}

// Parallel
export function executeSyncChunksSequentially<InputChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: SyncProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions = {
    id: 'unnamed',
    logger: defaultLogger,
  },
): Promise<OutputChunk[]> {
  return new Promise((resolve, reject) => {
    if (inputChunks.length === 0) {
      return resolve([])
    }

    const results: OutputChunk[] = []
    processIteration(0, inputChunks, processor, options, results, resolve, reject)
  })
}

function processIteration<InputChunk, OutputChunk>(
  index: number,
  inputs: readonly InputChunk[],
  processor: SyncProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions,
  results: OutputChunk[],
  resolve: (output: OutputChunk[]) => void,
  reject: (err: unknown) => void,
) {
  setImmediate(() => {
    try {
      const startTime = options.warningThresholdInMsecs ? Date.now() : 0
      const chunk = inputs[index]
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
      if (results.length !== inputs.length) {
        processIteration(index + 1, inputs, processor, options, results, resolve, reject)
      } else {
        resolve(results)
      }
    } catch (err) {
      reject(err)
    }
  })
}
