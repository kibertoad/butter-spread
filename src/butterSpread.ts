import type { Logger } from './logger'
import { defaultLogger } from './logger'

export type SyncProcessor<InputChunk, OutputChunk> = (chunk: InputChunk) => OutputChunk

export type ExecutionOptions = {
  id: string
  executeSynchronouslyThresholdInMsecs?: number
  warningThresholdInMsecs?: number
  logger?: Logger
}

export const defaultExecutionOptions = {
  warningThresholdInMsecs: 20,
  executeSynchronouslyThresholdInMsecs: 10,
  logger: defaultLogger,
} as const

// One by one
export function executeSyncChunksSequentially<InputChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: SyncProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions,
): Promise<OutputChunk[]> {
  return new Promise((resolve, reject) => {
    if (inputChunks.length === 0) {
      return resolve([])
    }

    const results: OutputChunk[] = []
    setImmediate(() =>
      processIteration(
        0,
        inputChunks,
        processor,
        {
          ...defaultExecutionOptions,
          ...options,
        },
        results,
        resolve,
        reject,
        0,
      ),
    )
  })
}

function processIteration<InputChunk, OutputChunk>(
  index: number,
  inputs: readonly InputChunk[],
  processor: SyncProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions & {
    logger: Logger
    executeSynchronouslyThresholdInMsecs: number
  },
  results: OutputChunk[],
  resolve: (output: OutputChunk[]) => void,
  reject: (err: unknown) => void,
  totalTimeSoFarInMsecs: number,
) {
  try {
    const startTime = Date.now()
    const chunk = inputs[index]
    results.push(processor(chunk))
    const timeTaken = Date.now() - startTime + totalTimeSoFarInMsecs
    if (options.warningThresholdInMsecs) {
      if (timeTaken >= options.warningThresholdInMsecs) {
        const length = Array.isArray(chunk) || typeof chunk === 'string' ? chunk.length : 1
        options.logger.warn(
          `Execution "${options.id}" has exceeded the threshold, took ${timeTaken} msecs for a single iteration, processing ${length} elements.`,
        )
      }
    }
    if (results.length !== inputs.length) {
      // we haven't exceeded our threshold for deferred execution, let's continue
      if (timeTaken < options.executeSynchronouslyThresholdInMsecs) {
        processIteration(index + 1, inputs, processor, options, results, resolve, reject, timeTaken)
      } else {
        setImmediate(() => processIteration(index + 1, inputs, processor, options, results, resolve, reject, 0))
      }
    } else {
      resolve(results)
    }
  } catch (err) {
    reject(err)
  }
}
