# butter-spread

[![npm version](http://img.shields.io/npm/v/butter-spread.svg)](https://npmjs.org/package/butter-spread)
![](https://github.com/kibertoad/butter-spread/workflows/ci/badge.svg)
[![Coverage Status](https://coveralls.io/repos/kibertoad/butter-spread/badge.svg?branch=main)](https://coveralls.io/r/kibertoad/butter-spread?branch=main)

Execute chunked blocking operations in a way that won't cause event loop starvation.

Note that you should also consider using worker threads; [piscina](https://github.com/piscinajs/piscina) is a fantastic library for that. Thread management, however, comes with an overhead of its own, and is not recommended for operations that execute within 10-20 msecs. Also be mindful of the "rule of a thumb" for determining how many threads you should be running on your server, which in simplified form is `cpus * 1.5` threads, rounded down.

If you have to run your app in an environment that only has a single core, your processing typically completes fast (but can sometimes spike), or you are searching for a simpler solution, look no further than this library!

## Node.js task queue consideration

Each following chunk of work is added to the end of the event loop task queue after previous one is finished.

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

### executeMixedChunksSequentially

Processes chunks using a processor that can return either a value or a Promise. When the processor returns a Promise, the `await` naturally yields to the event loop, and threshold counters are reset. When it returns a value synchronously, the same threshold-based yielding as `executeSyncChunksSequentially` applies.

This is useful when some chunks require async operations (e.g. I/O) while others are purely computational.

**Important:** The async path must perform real async work (I/O, `setTimeout`, `setImmediate`) that yields the event loop. `await Promise.resolve(value)` resolves as a microtask on the current tick and does **not** yield — the executor resets its time counter assuming the `await` yielded, but no yielding actually occurs. If your processor always returns synchronously-resolved promises (e.g. a cache that wraps results in `Promise.resolve()`), use `executeSyncChunksSequentially` instead and unwrap the cache synchronously.

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

`asyncPostProcess` receives the array of accumulated sync results and must return a Promise of an array of output values. The output array does not need to have the same length as the input — this allows filtering or expansion during post-processing.

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

## Stream utilities

### batchFromStream

Accumulates items from any `Iterable` or `AsyncIterable` (including Node.js readable streams) into fixed-size batches. Useful for composing stream consumption with chunked processing.

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

Splits an array into fixed-size chunks.

```ts
import { chunk } from 'butter-spread'

chunk([1, 2, 3, 4, 5], 2) // [[1, 2], [3, 4], [5]]
```

### splitTextPreserveWords

Splits text into segments of a maximum length while preserving word boundaries.

```ts
import { splitTextPreserveWords } from 'butter-spread'

splitTextPreserveWords('hello world foo', 11) // ['hello world', 'foo']
```

### getSlicePreserveWords

Returns a single text slice from a starting position while preserving word boundaries.

```ts
import { getSlicePreserveWords } from 'butter-spread'

getSlicePreserveWords('hello world foo bar', 11) // 'hello world'
getSlicePreserveWords('hello world foo bar', 11, 6) // 'world foo'
```
