# Patterns: Event Loop, Streams, and Deferred Execution

This document covers common problems in Node.js related to event loop starvation and stream backpressure, their native solutions, and where `butter-spread` fits in.

## The problem: event loop starvation

Node.js runs JavaScript on a single thread. When synchronous code runs for too long, it blocks the event loop — HTTP requests queue up, timers miss their deadlines, and the process appears frozen.

```ts
// Bad: blocks the event loop for the entire duration
const results = hugeArray.map((item) => expensiveTransform(item))
```

This is fine when the array is small or the transform is fast. It becomes a problem when the total sync time exceeds ~10-20ms, which is enough to cause noticeable latency spikes for other requests.

### Native solution: `setImmediate`

`setImmediate` schedules a callback at the end of the current event loop iteration, allowing pending I/O and timers to execute first:

```ts
function processInChunks(items, chunkSize, processor) {
    let index = 0
    return new Promise((resolve) => {
        function next() {
            const end = Math.min(index + chunkSize, items.length)
            for (; index < end; index++) {
                processor(items[index])
            }
            if (index < items.length) {
                setImmediate(next) // yield to event loop
            } else {
                resolve()
            }
        }
        setImmediate(next)
    })
}
```

This works but requires manual chunk size tuning. Too small = overhead from scheduling. Too large = back to blocking.

### butter-spread solution: threshold-based yielding

Instead of a fixed chunk size, `butter-spread` measures elapsed time and yields when a threshold is exceeded. This adapts automatically to the speed of the processor:

```ts
import { chunk, executeSyncChunksSequentially } from 'butter-spread'

// Split a large array of text segments for NLP processing
const chunks = chunk(textSegments, 100)
const results = await executeSyncChunksSequentially(chunks, (chunk) => {
    return chunk.map((segment) => stemmer.tokenizeAndStem(segment))
}, {
    id: 'NLP tokenization',
    executeSynchronouslyThresholdInMsecs: 15, // yield after 15ms of sync work
    warningThresholdInMsecs: 30, // log a warning if a single chunk blocks for 30ms+
})
```

If the transform is fast, many chunks run in a single tick. If it's slow, the library yields more often. You don't need to guess the right chunk size for your hardware.

## The problem: mixed sync/async processing

Sometimes a processor is synchronous for most inputs but needs to go async for others — e.g., a cache that hits memory for most lookups but falls back to a database:

```ts
// Naive approach: always async, even when not needed
for (const key of keys) {
    const value = await lookup(key) // unnecessary await on cache hits
    results.push(value)
}
```

Making every call `async` is correct but introduces unnecessary yielding overhead when most calls resolve synchronously.

### butter-spread solution: mixed execution

`executeMixedChunksSequentially` detects whether each processor call returns a value or a Promise. Sync returns accumulate without yielding; async returns naturally yield and reset counters:

```ts
import { chunk, executeMixedChunksSequentially } from 'butter-spread'

const chunks = chunk(keys, 50)
const results = await executeMixedChunksSequentially(chunks, (keyBatch) => {
    const allCached = keyBatch.every((key) => cache.has(key))
    if (allCached) {
        // Fast path: pure sync, no event loop yield needed
        return keyBatch.map((key) => cache.get(key))
    }
    // Slow path: async DB lookup, naturally yields to event loop
    return fetchFromDatabase(keyBatch)
}, {
    id: 'cache-lookup',
})
```

## The problem: sync transform followed by async I/O

Many real-world pipelines look like this:

```ts
for (const batch of batches) {
    const transformed = batch.map((item) => cpuIntensiveTransform(item)) // sync, may block
    await bulkInsert(transformed) // async, yields
}
```

The `await` yields to the event loop, but only *after* the entire `.map()` completes. If the batch has thousands of items with regex replacements, JSON parsing, or UUID conversions, that `.map()` can block for 20-50ms.

### Native solution: manual chunking with `setImmediate`

```ts
async function processWithYielding(items, transformFn, insertFn, timeLimit) {
    let pending = []
    let start = Date.now()
    for (const item of items) {
        pending.push(transformFn(item))
        if (Date.now() - start >= timeLimit) {
            await insertFn(pending)
            pending = []
            start = Date.now()
            await new Promise((resolve) => setImmediate(resolve))
        }
    }
    if (pending.length > 0) await insertFn(pending)
}
```

This works but is boilerplate-heavy and easy to get wrong (forgetting the final flush, incorrect timing, no warning logging).

### butter-spread solution: two-phase execution

`executeTwoPhaseChunksSequentially` encapsulates this pattern. It accumulates sync results until the time threshold is hit, then flushes the batch to the async post-processor:

```ts
import { executeTwoPhaseChunksSequentially } from 'butter-spread'

// Snapshot restoration: parse JSONL lines, remap IDs, bulk insert
const results = await executeTwoPhaseChunksSequentially(jsonlLines, {
    syncTransform: (line) => {
        const parsed = JSON.parse(line)
        // CPU-intensive: regex key-reference replacement, UUID conversion
        return remapIds(parsed, idMapping)
    },
    asyncPostProcess: async (batch) => {
        // Single bulk insert for the accumulated batch
        return await db.insert(tableName).values(batch).returning()
    },
}, {
    id: 'restore-translations',
    executeSynchronouslyThresholdInMsecs: 15, // flush to DB and yield when sync time exceeds this
    warningThresholdInMsecs: 30, // log if sync transforms are taking too long
})
```

This runs sync transforms back-to-back for efficiency and flushes to a bulk insert when the event loop needs breathing room. The async phase resets all counters, so the next batch of sync transforms starts fresh.

## The problem: stream backpressure

When writing to a stream faster than it can flush, Node.js buffers the data in memory. Without backpressure handling, this can cause unbounded memory growth:

```ts
// Bad: ignores backpressure — memory grows if disk is slower than CPU
for (const item of hugeDataset) {
    writeStream.write(JSON.stringify(item) + '\n')
}
```

`stream.write()` returns `false` when the internal buffer exceeds `highWaterMark`, signaling you should stop writing until the `drain` event.

### Native solution: `stream.pipeline()`

The cleanest way to handle backpressure is to model your data source as a readable stream and connect it to the writable via `pipeline`:

```ts
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

// Database query stream → serialize → write to file
await pipeline(
    mysqlPool.query(query.sql, query.params).stream(),
    new Transform({
        objectMode: true,
        transform(row, _encoding, callback) {
            callback(null, JSON.stringify(Object.values(row)) + '\n')
        },
    }),
    fs.createWriteStream(outputPath),
)
```

`pipeline` handles backpressure automatically — when the writable can't keep up, the readable pauses. It also propagates errors and cleans up resources. **This is the preferred approach when your data source is a stream or can be expressed as one.**

### butter-spread solution: `drainAwareWrite`

When you're writing data from a source that isn't naturally a stream — e.g., generating items in a computation loop, or interleaving writes with other side effects — `drainAwareWrite` handles the backpressure check for you:

```ts
import { drainAwareWrite } from 'butter-spread'

const writeStream = fs.createWriteStream(snapshotPath)

for (const table of tables) {
    const rows = await fetchTableData(table)
    for (const row of rows) {
        const serialized = escapeJsonChars(JSON.stringify(Object.values(row))) + '\n'
        // Waits for drain if buffer is full — prevents unbounded memory growth
        await drainAwareWrite(writeStream, serialized)
    }
}
```

Note: if your data source is already a stream or async iterable, prefer `stream.pipeline()` instead — it handles backpressure natively and is more efficient.

## The problem: processing large streams in batches

When consuming a stream item-by-item, each `await` yields to the event loop. This is safe but often inefficient — you'd rather accumulate items into batches for bulk operations (e.g., batch DB inserts):

```ts
// Works, but inefficient: one DB call per line
for await (const line of readStream.pipe(split2())) {
    await insertRow(JSON.parse(line))
}
```

### Native solution: manual accumulation

```ts
let batch = []
for await (const line of readStream.pipe(split2())) {
    batch.push(JSON.parse(line))
    if (batch.length >= 1000) {
        await bulkInsert(batch)
        batch = []
    }
}
if (batch.length > 0) await bulkInsert(batch)
```

This works but is boilerplate that's easy to get wrong (forgetting the final flush, off-by-one on batch size).

### butter-spread solution: `batchFromStream` + two-phase execution

`batchFromStream` extracts the accumulation logic into a composable async generator. Combined with `executeTwoPhaseChunksSequentially`, you get batched I/O with event-loop-safe sync transforms:

```ts
import { batchFromStream, executeTwoPhaseChunksSequentially } from 'butter-spread'

const lineStream = fs.createReadStream(filePath, { encoding: 'utf8' }).pipe(split2())

for await (const batch of batchFromStream(lineStream, 1000)) {
    await executeTwoPhaseChunksSequentially(batch, {
        syncTransform: (line) => {
            // CPU-intensive: JSON parse + data transformation per line
            const parsed = JSON.parse(line)
            return remapIds(parsed, idMapping)
        },
        asyncPostProcess: async (transformedBatch) => {
            // Single bulk insert for the accumulated batch
            return await bulkInsert(transformedBatch)
        },
    }, { id: 'restore-table' })
}
```

This gives you:
- **Batched I/O**: fewer, larger DB calls instead of one per line
- **Event-loop-safe sync transforms**: yields when the sync threshold is hit, so heavy transforms (regex, UUID conversion) don't block
- **Natural backpressure**: the `for await` pauses the source stream when processing is slow
- **Clean separation**: batching, sync processing, and async I/O are each handled by the right tool

`batchFromStream` works with any `Iterable` or `AsyncIterable`, including Node.js readable streams, database cursors, and plain generators.

## When you don't need butter-spread

- **Purely async processing**: If every operation is `await`-ed (e.g., HTTP calls, DB queries with no sync transform), the event loop already yields between operations. Butter-spread adds no value.
- **Small datasets**: If the total sync processing time is under ~10ms, chunking adds overhead for no benefit.
- **Worker threads**: For truly CPU-heavy work (100ms+ per batch), consider [piscina](https://github.com/piscinajs/piscina) to offload to a worker thread instead of chunking on the main thread.
- **Stream-to-stream transforms**: Use `stream.pipeline()` with Transform streams — it handles backpressure natively and is more efficient than imperative write loops.
- **Trivial per-item transforms**: If your sync transform per item is fast (e.g., a simple property access), the stream's own async iteration already provides sufficient yielding.

## Further reading

- [Don't Block the Event Loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) — Node.js guide on event loop starvation, partitioning, and offloading
- [The Node.js Event Loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick) — How the event loop, timers, `setImmediate`, and `process.nextTick` work
- [Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams) — Node.js guide on stream backpressure, `highWaterMark`, and the `drain` event
- [piscina](https://github.com/piscinajs/piscina) — Worker thread pool for CPU-intensive tasks that exceed what chunking on the main thread can handle
