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
   * chunk. Must be a finite, non-negative number. Defaults to `15`.
   */
  executeSynchronouslyThresholdInMsecs?: number
  /**
   * When a synchronous burst exceeds this threshold (in milliseconds), the executor
   * emits one warning per burst describing the slowdown. Set to `0` to disable.
   * Must be a finite, non-negative number. Defaults to `30`.
   */
  warningThresholdInMsecs?: number
  /** Logger to receive warnings. Defaults to `defaultLogger` (which calls `console.warn`). */
  logger?: Logger
}

/** Default values applied to {@link ExecutionOptions} fields that are left undefined. */
export const defaultExecutionOptions = {
  warningThresholdInMsecs: 30,
  executeSynchronouslyThresholdInMsecs: 15,
  logger: defaultLogger,
} as const

type ResolvedOptions = {
  id: string
  logger: Logger
  executeSynchronouslyThresholdInMsecs: number
  warningThresholdInMsecs: number
}

function assertThreshold(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${name} must be a finite, non-negative number of milliseconds, received ${String(value)}`,
    )
  }
}

function resolveOptions(options: ExecutionOptions): ResolvedOptions {
  const resolved: ResolvedOptions = {
    id: options.id,
    logger: options.logger ?? defaultExecutionOptions.logger,
    executeSynchronouslyThresholdInMsecs:
      options.executeSynchronouslyThresholdInMsecs ??
      defaultExecutionOptions.executeSynchronouslyThresholdInMsecs,
    warningThresholdInMsecs:
      options.warningThresholdInMsecs ?? defaultExecutionOptions.warningThresholdInMsecs,
  }
  assertThreshold(
    'executeSynchronouslyThresholdInMsecs',
    resolved.executeSynchronouslyThresholdInMsecs,
  )
  assertThreshold('warningThresholdInMsecs', resolved.warningThresholdInMsecs)
  return resolved
}

/**
 * Monotonic, sub-millisecond clock. `Date.now()` is wall-clock time: it has 1 ms
 * resolution (so sub-millisecond chunks would count as taking zero time) and can
 * jump backwards on clock adjustments, which would delay yielding.
 */
function now(): number {
  return performance.now()
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
  if (options.warningThresholdInMsecs === 0) return false
  if (timeTaken < options.warningThresholdInMsecs) return false
  const length = Array.isArray(chunk) || typeof chunk === 'string' ? chunk.length : 1
  options.logger.warn(
    `Execution "${options.id}" has exceeded the threshold, took ${Math.round(timeTaken)} msecs for a single iteration. ${chunksProcessed} chunks were processed. Last chunk took ${Math.round(chunkTimeTaken)} msecs for ${length} elements.`,
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
  const resolved = resolveOptions(options)
  if (inputChunks.length === 0) {
    return []
  }

  const results: OutputChunk[] = []

  // Initial yield so callers see consistent async behavior regardless of input size
  await yieldToEventLoop()

  let timeTaken = 0
  let chunksProcessed = 0
  let warned = false

  for (let index = 0; index < inputChunks.length; index++) {
    const chunk = inputChunks[index]
    const chunkStartTime = now()
    const chunkResult = processor(chunk)
    const chunkTimeTaken = now() - chunkStartTime

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
 *
 * Only the synchronous part of each call (the time until `processor` returns) counts
 * towards the burst thresholds: time spent waiting on a returned Promise does not
 * block the event loop, so it is neither accumulated nor reported in warnings. Once
 * the accumulated synchronous time reaches `executeSynchronouslyThresholdInMsecs`
 * the executor yields via `setImmediate`, regardless of whether the last chunk was
 * sync or async. This means a processor that returns already-settled promises
 * (`Promise.resolve(x)`, a cache wrapper) still yields correctly; the executor never
 * assumes that awaiting a Promise gave the event loop a turn.
 */
export async function executeMixedChunksSequentially<InputChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: MixedProcessor<InputChunk, OutputChunk>,
  options: ExecutionOptions,
): Promise<OutputChunk[]> {
  const resolved = resolveOptions(options)
  if (inputChunks.length === 0) {
    return []
  }

  const results: OutputChunk[] = []

  await yieldToEventLoop()

  let timeTaken = 0
  let chunksProcessed = 0
  let warned = false

  for (let index = 0; index < inputChunks.length; index++) {
    const chunk = inputChunks[index]
    const chunkStartTime = now()
    const rawResult = processor(chunk)
    // Measure only the synchronous portion; awaiting I/O does not block the loop
    const chunkTimeTaken = now() - chunkStartTime

    // Duck-type thenable check (handles cross-realm promises and custom thenables)
    const isThenable =
      rawResult !== null &&
      rawResult !== undefined &&
      typeof (rawResult as Promise<OutputChunk>).then === 'function'

    const chunkResult: OutputChunk = isThenable
      ? await (rawResult as Promise<OutputChunk>)
      : (rawResult as OutputChunk)

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
 * Validates one `asyncPostProcess` result and appends it to the accumulated output.
 *
 * @throws TypeError if `batchResults` is not an array (usually a forgotten `return`).
 */
function appendBatch<OutputChunk>(
  results: OutputChunk[],
  batchResults: OutputChunk[],
  executionId: string,
): void {
  if (!Array.isArray(batchResults)) {
    throw new TypeError(
      `Execution "${executionId}": asyncPostProcess must resolve to an array, received ${
        batchResults === null ? 'null' : typeof batchResults
      }`,
    )
  }
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
}

/**
 * Executes chunks in two explicit phases: a synchronous transform that accumulates
 * intermediates into a batch, followed by an async post-processing step (e.g. a bulk
 * database insert). Sync transforms run back-to-back until
 * `executeSynchronouslyThresholdInMsecs` is exceeded or the last chunk is reached,
 * then the accumulated batch is flushed to `asyncPostProcess`. Each non-final flush
 * yields the event loop and resets the burst counters, so an `asyncPostProcess` that
 * resolves synchronously still lets timers and I/O run between batches.
 *
 * Setting `executeSynchronouslyThresholdInMsecs: 0` flushes after every sync transform
 * — useful when downstream ordering or backpressure dictates one-at-a-time processing.
 * Output order is preserved across batches (each `asyncPostProcess` call is awaited
 * before the next sync transform begins).
 *
 * `asyncPostProcess` may return an array of any length, allowing filtering or
 * expansion during post-processing. Resolving to anything other than an array is a
 * `TypeError` (the most common cause is a forgotten `return`).
 */
export async function executeTwoPhaseChunksSequentially<InputChunk, IntermediateChunk, OutputChunk>(
  inputChunks: readonly InputChunk[],
  processor: TwoPhaseProcessor<InputChunk, IntermediateChunk, OutputChunk>,
  options: ExecutionOptions,
): Promise<OutputChunk[]> {
  const resolved = resolveOptions(options)
  if (inputChunks.length === 0) {
    return []
  }

  const results: OutputChunk[] = []

  await yieldToEventLoop()

  let timeTaken = 0
  let chunksProcessed = 0
  let warned = false
  let pendingIntermediates: IntermediateChunk[] = []

  for (let index = 0; index < inputChunks.length; index++) {
    const chunk = inputChunks[index]
    const chunkStartTime = now()
    const intermediate = processor.syncTransform(chunk)
    const chunkTimeTaken = now() - chunkStartTime

    pendingIntermediates.push(intermediate)
    timeTaken += chunkTimeTaken
    chunksProcessed++

    warned = maybeWarn(resolved, warned, timeTaken, chunkTimeTaken, chunksProcessed, chunk)

    const isLastChunk = index === inputChunks.length - 1
    if (isLastChunk || timeTaken >= resolved.executeSynchronouslyThresholdInMsecs) {
      appendBatch(results, await processor.asyncPostProcess(pendingIntermediates), resolved.id)

      pendingIntermediates = []
      timeTaken = 0
      chunksProcessed = 0
      warned = false

      // `asyncPostProcess` may resolve without ever scheduling a task (an identity
      // or cache-hit implementation), in which case `await` above resumes as a
      // microtask and the loop keeps hogging the current tick. Yield explicitly so
      // timers and I/O get a turn between batches.
      if (!isLastChunk) {
        await yieldToEventLoop()
      }
    }
  }

  return results
}
