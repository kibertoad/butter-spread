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
  warningThresholdInMsecs: 30,
  executeSynchronouslyThresholdInMsecs: 15,
  logger: defaultLogger,
} as const

// Schedule new chunk after previous one is completed or process immediately if execution threshold not yet exceeded
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
      ),
    )
  })
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is intentional
function processIteration<InputChunk, OutputChunk>(
  _index: number,
  inputs: readonly InputChunk[],
  processor: SyncProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions & {
    logger: Logger
    executeSynchronouslyThresholdInMsecs: number
  },
  results: OutputChunk[],
  resolve: (output: OutputChunk[]) => void,
  reject: (err: unknown) => void,
) {
  let timeTaken = 0
  let chunksProcessed = 0
  let stopProcessing = false
  let index = _index

  try {
    while (!stopProcessing) {
      const chunk = inputs[index]
      const chunkStartTime = Date.now()
      const chunkResult = processor(chunk)
      const chunkTimeTaken = Date.now() - chunkStartTime

      results.push(chunkResult)
      timeTaken += chunkTimeTaken
      chunksProcessed++

      if (options.warningThresholdInMsecs) {
        if (timeTaken >= options.warningThresholdInMsecs) {
          const length = Array.isArray(chunk) || typeof chunk === 'string' ? chunk.length : 1
          options.logger.warn(
            `Execution "${options.id}" has exceeded the threshold, took ${timeTaken} msecs for a single iteration. ${chunksProcessed} chunks were processed. Last chunk took ${chunkTimeTaken} msecs for ${length} elements.`,
          )
        }
      }
      if (results.length !== inputs.length) {
        // we haven't exceeded our threshold for deferred execution, let's continue
        if (timeTaken < options.executeSynchronouslyThresholdInMsecs) {
          index++
        } else {
          setImmediate(() =>
            processIteration(index + 1, inputs, processor, options, results, resolve, reject),
          )
          stopProcessing = true
        }
      } else {
        resolve(results)
        stopProcessing = true
      }
    }
  } catch (err) {
    reject(err)
  }
}
