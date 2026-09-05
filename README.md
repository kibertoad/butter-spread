# butter-spread

[![npm version](http://img.shields.io/npm/v/butter-spread.svg)](https://npmjs.org/package/butter-spread)
![](https://github.com/kibertoad/butter-spread/workflows/ci/badge.svg)
[![Coverage Status](https://coveralls.io/repos/kibertoad/butter-spread/badge.svg?branch=main)](https://coveralls.io/r/kibertoad/butter-spread?branch=main)

Execute chunked blocking operations in a way that won't cause event loop starvation.

Note that you should also consider using worker threads; [piscina](https://github.com/piscinajs/piscina) is a fantastic library for that. Thread management, however, comes with an overhead of its own, and is not recommended for operations that execute within 10-20 msecs. Also be mindful of the "rule of a thumb" for determining how many threads you should be running on your server, which in simplified form is `cpus * 1.5` threads, rounded down.

If you have to run your app in an environment that only has a single core, your processing typically completes fast (but can sometimes spike), or you are searching for a simpler solution, look no further than this library!

## Requirements

Node.js `>= 22.13` (declared via `engines.node`; npm warns on older versions, pnpm with `engine-strict=true` rejects them).

The package ships CommonJS with an `exports` map and type declarations; it can be `require`d or `import`ed from both CommonJS and ESM code.

## Node.js task queue consideration

Each following chunk of work is added to the end of the event loop task queue after the previous one is finished. The yielding primitive is [`setImmediate`](https://nodejs.org/api/timers.html#setimmediatecallback-args), which runs after pending I/O — not `process.nextTick` or `queueMicrotask`, which do not yield to I/O.

This potentially increases latency of processing a single batch operation while improving throughput - all new work that was received after first chunk started processing will be completed before second chunk will be processed.

If there are multiple `butter-spread`-managed operations running at the same time, processing time will be divided equally among them.

This behaviour can be controlled via `executeSynchronouslyThresholdInMsecs` option, which will keep processing chunks synchronously and immediately within the given timeframe.

## Choosing the right executor

| Executor | Use when |
|----------|----------|
| `executeSyncChunksSequentially` | All processing is synchronous (CPU-bound transforms, parsing, validation) |
| `executeMixedChunksSequentially` | Some chunks need async operations (I/O), others don't, and this isn't known upfront |
| `executeTwoPhaseChunksSequentially` | Every chunk has a CPU-bound transform followed by async I/O (e.g. parse then insert into DB) |

If your processing is purely async (e.g. fetching URLs), you don't need butter-spread — `await` already yields to the event loop.

## Chunked execution

### executeSyncChunksSequentially

Processes chunks using a synchronous processor, yielding to the event loop between iterations when the synchronous threshold is exceeded.

```ts
import { chunk, executeSyncChunksSequentially, defaultLogger } from 'butter-spread'

const chunks = chunk(someInputArray, 100)

const results = await executeSyncChunksSequentially(chunks, (chunk) => { return someProcessingLogic(chunk) }, {
    id: 'Some blocking operation', // this is used for logging purposes if threshold is exceeded
    logger: defaultLogger, // logger for "threshold exceeded" warnings. `console.warn` is used by default
    warningThresholdInMsecs: 30, // warning will be logged if any single iteration (which blocks the loop) will take longer than that
    executeSynchronouslyThresholdInMsecs: 15 // if total execution of all chunks in this iteration took less than this amount of time, next chunk will be processed immediately synchronously and not deferred
})
```

Both thresholds must be finite, non-negative numbers of milliseconds; anything else (negative, `NaN`, `Infinity`) rejects with a `RangeError` before any chunk is processed. `0` means "yield after every chunk" for `executeSynchronouslyThresholdInMsecs` and "never warn" for `warningThresholdInMsecs`. The defaults are exported as `defaultExecutionOptions`. Timing uses the monotonic `performance.now()` clock, so it is not affected by wall-clock adjustments.

### executeMixedChunksSequentially

Processes chunks using a processor that can return either a value or a Promise. Only the synchronous part of each call (the time until the processor returns) counts towards the thresholds: time spent awaiting a returned Promise does not block the event loop, so it is neither accumulated nor reported in warnings. Once the accumulated synchronous time reaches `executeSynchronouslyThresholdInMsecs`, the executor yields via `setImmediate`, whether the last chunk was sync or async.

This is useful when some chunks require async operations (e.g. I/O) while others are purely computational. It is also safe for processors that return already-settled promises (`Promise.resolve(value)`, a cache wrapper): the executor never assumes that awaiting a Promise gave the event loop a turn, so such chunks still yield correctly once the threshold is hit.

```ts
import { chunk, executeMixedChunksSequentially } from 'butter-spread'

const chunks = chunk(someInputArray, 100)

const results = await executeMixedChunksSequentially(chunks, (chunk) => {
    const transformed = transformSync(chunk)
    // Return a promise for some chunks, plain value for others
    if (needsAsyncProcessing(transformed)) {
        return saveToDatabase(transformed) // returns Promise
    }
    return transformed // returns value
}, {
    id: 'Mixed processing',
})
```

### executeTwoPhaseChunksSequentially

Processes chunks in two explicit phases: a synchronous transform followed by an async post-processing step (e.g. bulk database ingestion). Sync transforms are accumulated into a batch until the `executeSynchronouslyThresholdInMsecs` threshold is exceeded (or all chunks are processed), then the entire batch is flushed to `asyncPostProcess`. The async phase naturally yields to the event loop and resets threshold counters.

This is ideal for pipelines where CPU-intensive transformation is followed by I/O — the sync transforms run back-to-back for efficiency, and the async step handles the accumulated batch (e.g. a single bulk insert instead of N individual inserts).

`asyncPostProcess` receives the array of accumulated sync results and must return a Promise of an array of output values. The output array does not need to have the same length as the input — this allows filtering or expansion during post-processing. Resolving to anything other than an array (most often a forgotten `return`) rejects with a descriptive `TypeError`.

```ts
import { chunk, executeTwoPhaseChunksSequentially } from 'butter-spread'

const chunks = chunk(someInputArray, 100)

const results = await executeTwoPhaseChunksSequentially(chunks, {
    syncTransform: (chunk) => {
        // CPU-intensive work: parsing, validation, data transformation
        return transformData(chunk)
    },
    asyncPostProcess: async (transformedBatch) => {
        // I/O work: receives array of all sync results accumulated since last flush
        return await bulkInsert(transformedBatch)
    },
}, {
    id: 'Two-phase processing',
    warningThresholdInMsecs: 30, // warns if accumulated sync time exceeds this
    executeSynchronouslyThresholdInMsecs: 15, // flush to async and yield when sync time exceeds this
})
```

Setting `executeSynchronouslyThresholdInMsecs: 0` flushes after every sync transform — useful when downstream ordering or backpressure dictates one-at-a-time processing. Output order across batches is preserved (each `asyncPostProcess` call is awaited before the next sync transform begins).

## Stream utilities

### batchFromStream

Accumulates items from any `Iterable` or `AsyncIterable` (including Node.js readable streams) into fixed-size batches. Useful for composing stream consumption with chunked processing. `batchSize` must be an integer `>= 1`; anything else throws a `RangeError` synchronously.

Note: if your per-item processing is trivial (e.g. just an async DB call with no CPU work), plain `for await...of` already yields to the event loop and you don't need this utility. `batchFromStream` is valuable when you want to accumulate items for bulk operations or to feed into an executor like `executeTwoPhaseChunksSequentially`.

```ts
import { batchFromStream, executeTwoPhaseChunksSequentially } from 'butter-spread'

const readStream = fs.createReadStream(filePath, { encoding: 'utf8' }).pipe(split2())

for await (const batch of batchFromStream(readStream, 1000)) {
    await executeTwoPhaseChunksSequentially(batch, {
        syncTransform: (line) => JSON.parse(line),
        asyncPostProcess: async (parsedBatch) => await bulkInsert(parsedBatch),
    }, { id: 'Stream ingestion' })
}
```

### drainAwareWrite

Writes data to a `Writable` stream while respecting backpressure. If the stream's internal buffer is full (`write()` returns `false`), it waits for the `drain` event before resolving. This prevents unbounded memory growth when writing faster than the consumer can handle.

Note: if you can structure your data source as a readable stream or async iterable, prefer Node.js `stream.pipeline()` which handles backpressure natively. `drainAwareWrite` is for the common case where you're writing imperatively in a loop and can't restructure as a pipeline.

```ts
import { drainAwareWrite } from 'butter-spread'

const writeStream = fs.createWriteStream(outputPath)

for (const item of largeDataset) {
    const serialized = JSON.stringify(item) + '\n'
    await drainAwareWrite(writeStream, serialized)
}
```

## Array and text utilities

### chunk

Splits an array into fixed-size chunks. Fractional sizes are truncated; a size below `1` (or `NaN`) returns `[]`.

```ts
import { chunk } from 'butter-spread'

chunk([1, 2, 3, 4, 5], 2) // [[1, 2], [3, 4], [5]]
```

### splitTextPreserveWords

Splits text into segments of a maximum length while preserving word boundaries. Any whitespace (spaces, tabs, line breaks) counts as a boundary; segments never start or end with whitespace. Words longer than `maxLength` are emitted on their own rather than broken in half. `maxLength` must be a finite number `>= 1`, otherwise a `RangeError` is thrown.

```ts
import { splitTextPreserveWords } from 'butter-spread'

splitTextPreserveWords('hello world foo', 11) // ['hello world', 'foo']
```

### getSlicePreserveWords

Returns a single text slice from a starting position while preserving word boundaries.

```ts
import { getSlicePreserveWords } from 'butter-spread'

getSlicePreserveWords('hello world foo bar', 11) // 'hello world'
getSlicePreserveWords('hello world foo bar', 11, 5) // 'world foo' — startPos 5 is the space before 'world'
getSlicePreserveWords('hello world foo bar', 11, 6) // 'world foo'
```

Whitespace at the optional `startPos` is skipped, so it may point either at the first character of a word or at the whitespace before it. If it lands mid-word, the returned slice starts mid-word too. To iterate over a whole text, use `splitTextPreserveWords`. `sliceSize` must be a finite number `>= 1`, otherwise a `RangeError` is thrown.

## Logger

`Logger` is a minimal `{ warn: LogFn }` shape, intentionally compatible with [pino](https://github.com/pinojs/pino) and similar structured loggers. The default `defaultLogger` exposes only `warn` (backed by `console.warn`) — the rest of `console` is not part of the surface area.
