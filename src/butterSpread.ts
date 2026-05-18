import type { Logger } from './logger'
import { defaultLogger } from './logger'

/** Processor that synchronously transforms a single chunk into an output value. */
export type SyncProcessor<InputChunk, OutputChunk> = (chunk: InputChunk) => OutputChunk

/**
 * Processor that may return either a value (sync) or a Promise (async) for any
 * given chunk. The executor detects which by duck-typing the return value.
 */
export type MixedProcessor<InputChunk, OutputChunk> = (
  chunk: InputChunk,
) => OutputChunk | Promise<OutputChunk>

/**
 * Pair of processors describing a sync-transform-then-async-flush pipeline.
 *
 * `syncTransform` runs on each input chunk; intermediates accumulate into a batch.
 * `asyncPostProcess` receives the accumulated batch and may return any length of
 * output array (so it can filter, expand, or pass through).
 */
export type TwoPhaseProcessor<InputChunk, IntermediateChunk, OutputChunk> = {
  syncTransform: (chunk: InputChunk) => IntermediateChunk
  asyncPostProcess: (intermediates: IntermediateChunk[]) => Promise<OutputChunk[]>
}

/** Options shared across all chunked executors. */
export type ExecutionOptions = {
  /** Identifier surfaced in warning messages so you can attribute slowness to a call site. */
  id: string
  /**
   * Upper bound (in milliseconds) on a single synchronous burst before the executor
   * yields to the event loop via `setImmediate`. Set to `0` to yield after every
   * chunk. Defaults to `15`.
   */
  executeSynchronouslyThresholdInMsecs?: number
  /**
   * When a synchronous burst exceeds this threshold (in milliseconds), the executor
   * emits one warning per burst describing the slowdown. Set to `0` to disable.
   * Defaults to `30`.
   */
  warningThresholdInMsecs?: number
  /** Logger to receive warnings. Defaults to `defaultLogger` (which calls `console.warn`). */
  logger?: Logger
}

export const defaultExecutionOptions = {
  warningThresholdInMsecs: 30,
  executeSynchronouslyThresholdInMsecs: 15,
  logger: defaultLogger,
} as const

type ResolvedOptions = ExecutionOptions & {
  logger: Logger
  executeSynchronouslyThresholdInMsecs: number
}

function resolveOptions(options: ExecutionOptions): ResolvedOptions {
  return {
    ...defaultExecutionOptions,
    ...options,
    logger: options.logger ?? defaultExecutionOptions.logger,
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Emits at most one warning per burst when `timeTaken` exceeds the warning threshold.
 * Returns `true` once a warning has been emitted in the current burst so the caller
 * can suppress duplicates until the next yield resets the latch.
 */
function maybeWarn(
  options: ResolvedOptions,
  alreadyWarned: boolean,
  timeTaken: number,
  chunkTimeTaken: number,
  chunksProcessed: number,
  chunk: unknown,
): boolean {
  if (alreadyWarned) return true
  if (!options.warningThresholdInMsecs) return false
  if (timeTaken < options.warningThresholdInMsecs) return false
  const length = Array.isArray(chunk) || typeof chunk === 'string' ? chunk.length : 1
  options.logger.warn(
    `Execution "${options.id}" has exceeded the threshold, took ${timeTaken} msecs for a single iteration. ${chunksProcessed} chunks were processed. Last chunk took ${chunkTimeTaken} msecs for ${length} elements.`,
  )
  return true
}

/**
 * Executes chunks through a synchronous processor, yielding to the event loop via
 * `setImmediate` whenever a burst of work exceeds `executeSynchronouslyThresholdInMsecs`.
 *
 * Use this for CPU-bound transforms (parsing, validation, stemming) that would
 * otherwise block the event loop for tens or hundreds of milliseconds. Results
 * are returned in input order.
 */
export async function executeSyncChunksSequentially<InputChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: SyncProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions,
): Promise<OutputChunk[]> {
  if (inputChunks.length === 0) {
    return []
  }

  const resolved = resolveOptions(options)
  const results: OutputChunk[] = []

  // Initial yield so callers see consistent async behavior regardless of input size
  await yieldToEventLoop()

  let timeTaken = 0
  let chunksProcessed = 0
  let warned = false

  for (let index = 0; index < inputChunks.length; index++) {
    const chunk = inputChunks[index]
    const chunkStartTime = Date.now()
    const chunkResult = processor(chunk)
    const chunkTimeTaken = Date.now() - chunkStartTime

    results.push(chunkResult)
    timeTaken += chunkTimeTaken
    chunksProcessed++

    warned = maybeWarn(resolved, warned, timeTaken, chunkTimeTaken, chunksProcessed, chunk)

    if (
      index < inputChunks.length - 1 &&
      timeTaken >= resolved.executeSynchronouslyThresholdInMsecs
    ) {
      await yieldToEventLoop()
      timeTaken = 0
      chunksProcessed = 0
      warned = false
    }
  }

  return results
}

/**
 * Executes chunks through a processor that may return either a value or a Promise.
 * When the processor returns a Promise, awaiting it naturally yields the event loop
 * and resets the executor's burst counters. When it returns a value, the same
 * threshold-based yielding as {@link executeSyncChunksSequentially} applies.
 *
 * **Important:** the async path must perform real async work (I/O, `setTimeout`,
 * `setImmediate`) that actually yields the event loop. `await Promise.resolve(x)`
 * resolves as a microtask on the current tick and does not yield — this executor
 * resets its counter assuming the await yielded, but no yielding actually occurs.
 * If your processor always returns synchronously-resolved promises (e.g. a cache
 * that wraps results in `Promise.resolve()`), use {@link executeSyncChunksSequentially}
 * and unwrap the cache synchronously instead.
 */
export async function executeMixedChunksSequentially<InputChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: MixedProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions,
): Promise<OutputChunk[]> {
  if (inputChunks.length === 0) {
    return []
  }

  const resolved = resolveOptions(options)
  const results: OutputChunk[] = []

  await yieldToEventLoop()

  let timeTaken = 0
  let chunksProcessed = 0
  let warned = false

  for (let index = 0; index < inputChunks.length; index++) {
    const chunk = inputChunks[index]
    const chunkStartTime = Date.now()
    const rawResult = processor(chunk)

    // Duck-type thenable check (handles cross-realm promises and custom thenables)
    const isThenable =
      rawResult !== null &&
      rawResult !== undefined &&
      typeof (rawResult as Promise<OutputChunk>).then === 'function'

    const chunkResult: OutputChunk = isThenable
      ? await (rawResult as Promise<OutputChunk>)
      : (rawResult as OutputChunk)
    const chunkTimeTaken = Date.now() - chunkStartTime

    results.push(chunkResult)
    timeTaken += chunkTimeTaken
    chunksProcessed++

    warned = maybeWarn(resolved, warned, timeTaken, chunkTimeTaken, chunksProcessed, chunk)

    if (isThenable) {
      // The await already yielded the event loop, reset counters
      timeTaken = 0
      chunksProcessed = 0
      warned = false
    } else if (
      index < inputChunks.length - 1 &&
      timeTaken >= resolved.executeSynchronouslyThresholdInMsecs
    ) {
      await yieldToEventLoop()
      timeTaken = 0
      chunksProcessed = 0
      warned = false
    }
  }

  return results
}

/**
 * Executes chunks in two explicit phases: a synchronous transform that accumulates
 * intermediates into a batch, followed by an async post-processing step (e.g. a bulk
 * database insert). Sync transforms run back-to-back until
 * `executeSynchronouslyThresholdInMsecs` is exceeded or the last chunk is reached,
 * then the accumulated batch is flushed to `asyncPostProcess`. The async phase
 * naturally yields the event loop and resets the burst counters.
 *
 * Setting `executeSynchronouslyThresholdInMsecs: 0` flushes after every sync transform
 * — useful when downstream ordering or backpressure dictates one-at-a-time processing.
 * Output order is preserved across batches (each `asyncPostProcess` call is awaited
 * before the next sync transform begins).
 *
 * `asyncPostProcess` may return an array of any length, allowing filtering or
 * expansion during post-processing.
 */
export async function executeTwoPhaseChunksSequentially<InputChunk, IntermediateChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: TwoPhaseProcessor<InputChunk, IntermediateChunk, OutputChunk>,
  options: ExecutionOptions,
): Promise<OutputChunk[]> {
  if (inputChunks.length === 0) {
    return []
  }

  const resolved = resolveOptions(options)
  const results: OutputChunk[] = []

  await yieldToEventLoop()

  let timeTaken = 0
  let chunksProcessed = 0
  let warned = false
  let pendingIntermediates: IntermediateChunk[] = []

  for (let index = 0; index < inputChunks.length; index++) {
    const chunk = inputChunks[index]
    const chunkStartTime = Date.now()
    const intermediate = processor.syncTransform(chunk)
    const chunkTimeTaken = Date.now() - chunkStartTime

    pendingIntermediates.push(intermediate)
    timeTaken += chunkTimeTaken
    chunksProcessed++

    warned = maybeWarn(resolved, warned, timeTaken, chunkTimeTaken, chunksProcessed, chunk)

    const isLastChunk = index === inputChunks.length - 1
    if (isLastChunk || timeTaken >= resolved.executeSynchronouslyThresholdInMsecs) {
      const batchResults = await processor.asyncPostProcess(pendingIntermediates)
      // Append via indexed push instead of `results.push(...batchResults)`:
      // spread would exceed V8's argument-count limit (~65535) for large async
      // batches (RangeError), which the headline use case (bulk DB returning
      // rows) can hit. Indexed push is safe at any size and keeps the result
      // array PACKED — preallocation via `results.length = ...` would force a
      // HOLEY transition that costs more in downstream iteration than it saves
      // here. The ~1.3x overhead vs spread is negligible next to the I/O cost
      // of `asyncPostProcess` itself.
      const batchLen = batchResults.length
      for (let i = 0; i < batchLen; i++) {
        results.push(batchResults[i])
      }

      pendingIntermediates = []
      timeTaken = 0
      chunksProcessed = 0
      warned = false
    }
  }

  return results
}
