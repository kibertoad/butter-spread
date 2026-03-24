import type { Logger } from './logger'
import { defaultLogger } from './logger'

export type SyncProcessor<InputChunk, OutputChunk> = (chunk: InputChunk) => OutputChunk
export type MixedProcessor<InputChunk, OutputChunk> = (
  chunk: InputChunk,
) => OutputChunk | Promise<OutputChunk>
export type TwoPhaseProcessor<InputChunk, IntermediateChunk, OutputChunk> = {
  syncTransform: (chunk: InputChunk) => IntermediateChunk
  asyncPostProcess: (intermediates: IntermediateChunk[]) => Promise<OutputChunk[]>
}

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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is intentional
export async function executeMixedChunksSequentially<InputChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: MixedProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions,
): Promise<OutputChunk[]> {
  if (inputChunks.length === 0) {
    return []
  }

  const resolvedOptions = { ...defaultExecutionOptions, ...options }
  const results: OutputChunk[] = []

  // Initial yield to match existing behavior
  await new Promise<void>((resolve) => setImmediate(resolve))

  let timeTaken = 0
  let chunksProcessed = 0

  for (let index = 0; index < inputChunks.length; index++) {
    const chunk = inputChunks[index]
    const chunkStartTime = Date.now()
    const rawResult = processor(chunk)

    // Duck-type thenable check (handles cross-realm promises and custom thenables)
    if (
      rawResult !== null &&
      rawResult !== undefined &&
      typeof (rawResult as Promise<OutputChunk>).then === 'function'
    ) {
      // Async path: await the promise, then reset counters since event loop was yielded
      const chunkResult = await (rawResult as Promise<OutputChunk>)
      const chunkTimeTaken = Date.now() - chunkStartTime

      results.push(chunkResult)
      timeTaken += chunkTimeTaken
      chunksProcessed++

      if (resolvedOptions.warningThresholdInMsecs) {
        if (timeTaken >= resolvedOptions.warningThresholdInMsecs) {
          const length = Array.isArray(chunk) || typeof chunk === 'string' ? chunk.length : 1
          resolvedOptions.logger.warn(
            `Execution "${resolvedOptions.id}" has exceeded the threshold, took ${timeTaken} msecs for a single iteration. ${chunksProcessed} chunks were processed. Last chunk took ${chunkTimeTaken} msecs for ${length} elements.`,
          )
        }
      }

      // The await already yielded the event loop, reset counters
      timeTaken = 0
      chunksProcessed = 0
    } else {
      // Sync path: identical to executeSyncChunksSequentially behavior
      const chunkResult = rawResult as OutputChunk
      const chunkTimeTaken = Date.now() - chunkStartTime

      results.push(chunkResult)
      timeTaken += chunkTimeTaken
      chunksProcessed++

      if (resolvedOptions.warningThresholdInMsecs) {
        if (timeTaken >= resolvedOptions.warningThresholdInMsecs) {
          const length = Array.isArray(chunk) || typeof chunk === 'string' ? chunk.length : 1
          resolvedOptions.logger.warn(
            `Execution "${resolvedOptions.id}" has exceeded the threshold, took ${timeTaken} msecs for a single iteration. ${chunksProcessed} chunks were processed. Last chunk took ${chunkTimeTaken} msecs for ${length} elements.`,
          )
        }
      }

      // Yield to event loop when sync threshold exceeded (and more chunks remain)
      if (
        index < inputChunks.length - 1 &&
        timeTaken >= resolvedOptions.executeSynchronouslyThresholdInMsecs
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        timeTaken = 0
        chunksProcessed = 0
      }
    }
  }

  return results
}

export async function executeTwoPhaseChunksSequentially<InputChunk, IntermediateChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: TwoPhaseProcessor<InputChunk, IntermediateChunk, OutputChunk>,
  options: ExecutionOptions,
): Promise<OutputChunk[]> {
  if (inputChunks.length === 0) {
    return []
  }

  const resolvedOptions = { ...defaultExecutionOptions, ...options }
  const results: OutputChunk[] = []

  // Initial yield to match existing behavior
  await new Promise<void>((resolve) => setImmediate(resolve))

  let timeTaken = 0
  let chunksProcessed = 0
  let pendingIntermediates: IntermediateChunk[] = []

  for (let index = 0; index < inputChunks.length; index++) {
    const chunk = inputChunks[index]

    // Phase 1: Synchronous transform — accumulate intermediates
    const chunkStartTime = Date.now()
    const intermediate = processor.syncTransform(chunk)
    const chunkTimeTaken = Date.now() - chunkStartTime

    pendingIntermediates.push(intermediate)
    timeTaken += chunkTimeTaken
    chunksProcessed++

    if (resolvedOptions.warningThresholdInMsecs) {
      if (timeTaken >= resolvedOptions.warningThresholdInMsecs) {
        const length = Array.isArray(chunk) || typeof chunk === 'string' ? chunk.length : 1
        resolvedOptions.logger.warn(
          `Execution "${resolvedOptions.id}" has exceeded the threshold, took ${timeTaken} msecs for a single iteration. ${chunksProcessed} chunks were processed. Last chunk took ${chunkTimeTaken} msecs for ${length} elements.`,
        )
      }
    }

    // Flush when sync threshold is exceeded or on the last chunk
    const isLastChunk = index === inputChunks.length - 1
    if (isLastChunk || timeTaken >= resolvedOptions.executeSynchronouslyThresholdInMsecs) {
      // Phase 2: Async post-processing of accumulated batch (yields to event loop naturally)
      const batchResults = await processor.asyncPostProcess(pendingIntermediates)
      results.push(...batchResults)

      pendingIntermediates = []
      timeTaken = 0
      chunksProcessed = 0
    }
  }

  return results
}
