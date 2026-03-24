# Patterns: Event Loop, Streams, and Deferred Execution

This document covers common problems in Node.js related to event loop starvation and stream backpressure, and how to solve them — starting with native solutions that should be your first choice, then showing where `butter-spread` can help when they're not enough.

## Start here: do you actually need a library?

Most event-loop and backpressure problems have good native solutions built into Node.js. Reach for `butter-spread` only when the native approach doesn't fit:

| Problem | First choice (native) | When to consider butter-spread |
|---------|----------------------|-------------------------------|
| Sync code blocking the event loop | `setImmediate` with manual chunking | Per-item cost varies widely; you need the yielding to adapt at runtime |
| Stream backpressure on writes | `stream.pipeline()` with Transform streams | You need to interleave writes with side effects that break the pipeline model |
| Bulk-processing stream items | Manual batch accumulation in `for await` | You have multiple batch-processing sites and want a reusable primitive |
| Sync transform → async I/O pipeline | Manual `setImmediate`-based flushing | You have multiple such pipelines and want consistent threshold behavior and observability |

## Event loop starvation

Node.js runs JavaScript on a single thread. When synchronous code runs for too long, it blocks the event loop — HTTP requests queue up, timers miss their deadlines, and the process appears frozen.

```ts
// Bad: blocks the event loop for the entire duration
const results = hugeArray.map((item) => expensiveTransform(item))
```

This is fine when the array is small or the transform is fast. It becomes a problem when the total sync time exceeds ~10-20ms, which is enough to cause noticeable latency spikes for other requests.

### Recommended: `setImmediate` with manual chunking

`setImmediate` schedules a callback at the end of the current event loop iteration, allowing pending I/O and timers to execute first. This is the standard Node.js mechanism for yielding:

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

This is straightforward and has zero dependencies. It works well when the per-item cost is predictable — you profile once, pick a chunk size (say, 100 items), and it stays correct. If you only have one or two places in your codebase that need this, the manual approach is the right choice.

### With butter-spread: threshold-based yielding

The manual approach breaks down when per-item cost varies significantly. For example, NLP tokenization on short strings takes <1ms but on long paragraphs can take 10ms+. A fixed chunk size of 100 items might complete in 5ms for short text but 500ms for long text. You'd need to either pick a very conservative chunk size (hurting throughput on the common fast path) or accept occasional blocking on the slow path.

`butter-spread` replaces the fixed chunk size with a time-based threshold — it measures actual elapsed time and yields when the threshold is exceeded:

```ts
import { chunk, executeSyncChunksSequentially } from 'butter-spread'

const chunks = chunk(textSegments, 100)
const results = await executeSyncChunksSequentially(chunks, (chunk) => {
    return chunk.map((segment) => stemmer.tokenizeAndStem(segment))
}, {
    id: 'NLP tokenization',
    executeSynchronouslyThresholdInMsecs: 15, // yield after 15ms of sync work
    warningThresholdInMsecs: 30, // log a warning if a single chunk blocks for 30ms+
})
```

Concrete differences from the manual approach:
- **Adaptive yielding**: if 80 items process in 14ms, the 81st runs immediately. If 3 items take 16ms, it yields after 3. The manual approach always processes the same fixed count.
- **Warning logging**: when a chunk exceeds the warning threshold, it logs which operation, how long it took, and how many items. This helps you detect performance regressions in production without adding your own instrumentation.
- **Consistent interface**: if you have many chunked-processing call sites, they all use the same `ExecutionOptions` shape with the same threshold semantics, rather than each reimplementing its own timing logic.

If your per-item cost is stable and you only chunk in one or two places, the native approach is simpler and has no dependency cost.

## Stream backpressure

When writing to a stream faster than it can flush, Node.js buffers the data in memory. Without backpressure handling, this can cause unbounded memory growth:

```ts
// Bad: ignores backpressure — memory grows if disk is slower than CPU
for (const item of hugeDataset) {
    writeStream.write(JSON.stringify(item) + '\n')
}
```

`stream.write()` returns `false` when the internal buffer exceeds `highWaterMark`, signaling you should stop writing until the `drain` event.

### Recommended: `stream.pipeline()`

**This is the right solution for most backpressure problems.** `pipeline` connects a readable source to a writable destination and handles backpressure, error propagation, and resource cleanup automatically:

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

When the file write can't keep up, the database stream automatically pauses. When it drains, the stream resumes. No manual buffering or drain handling needed.

Even if your data source isn't a stream, you can often wrap it:

```ts
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

async function* generateRows() {
    for (const table of tables) {
        const rows = await fetchTableData(table)
        for (const row of rows) {
            yield JSON.stringify(row) + '\n'
        }
    }
}

await pipeline(
    Readable.from(generateRows()),
    fs.createWriteStream(outputPath),
)
```

**Prefer `pipeline` whenever you can express your data source as a stream or async generator.** It is more efficient, handles errors correctly, and cleans up resources on failure.

### With butter-spread: `drainAwareWrite`

`drainAwareWrite` exists for a narrow case: when you're writing in an imperative loop and **cannot restructure as a pipeline** because you need to interleave writes with side effects that don't fit the stream model.

For example, if you're writing data for multiple tables to the same file and need to update a manifest between tables:

```ts
import { drainAwareWrite } from 'butter-spread'

const writeStream = fs.createWriteStream(snapshotPath)

for (const table of tables) {
    const rows = await fetchTableData(table)
    for (const row of rows) {
        const serialized = escapeJsonChars(JSON.stringify(Object.values(row))) + '\n'
        await drainAwareWrite(writeStream, serialized)
    }
    // This side effect between tables breaks the pipeline model —
    // you can't express "write rows, then update manifest, then write more rows"
    // as a single Transform stream without awkward state management
    await updateManifest(table, rows.length)
}
```

If you can restructure the above as a generator that yields serialized lines (moving the manifest update elsewhere), use `pipeline` instead. `drainAwareWrite` is the fallback when that restructuring isn't practical.

## Processing large streams in batches

When consuming a stream item-by-item, each `await` yields to the event loop. This is safe but often inefficient — you'd rather accumulate items into batches for bulk operations:

```ts
// Works, but inefficient: one DB call per line
for await (const line of readStream.pipe(split2())) {
    await insertRow(JSON.parse(line))
}
```

### Recommended: manual batch accumulation

This is simple and dependency-free:

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

This is the right approach when:
- The per-item transform is trivial (like `JSON.parse` on small objects)
- You only batch in one or two places in your codebase
- You don't need event-loop yielding during the sync transform (because it's fast)

The `for await` already yields to the event loop between items, and the `await bulkInsert` yields between batches.

### With butter-spread: `batchFromStream` + two-phase execution

`batchFromStream` on its own is a thin convenience — it replaces the manual accumulation loop above with a reusable async generator. The value is modest: it eliminates the "don't forget to flush the final batch" bug and composes cleanly in a `for await` loop. If you batch in one place, the manual version is fine. If you batch in many places (e.g., restoring 10+ database tables from separate JSONL files), a shared primitive avoids repeating the accumulation logic.

The real value appears when you combine it with `executeTwoPhaseChunksSequentially` and the per-item sync transform is expensive. In the manual approach, `JSON.parse` + `remapIds` running on 1000 items happens in a single synchronous `.map()` call. If `remapIds` involves regex replacements and UUID conversions on 1000 translation rows, that `.map()` can block for 20-50ms. The manual batch accumulation has no way to yield mid-batch.

```ts
import { batchFromStream, executeTwoPhaseChunksSequentially } from 'butter-spread'

const lineStream = fs.createReadStream(filePath, { encoding: 'utf8' }).pipe(split2())

for await (const batch of batchFromStream(lineStream, 1000)) {
    await executeTwoPhaseChunksSequentially(batch, {
        syncTransform: (line) => {
            const parsed = JSON.parse(line)
            return remapIds(parsed, idMapping)
        },
        asyncPostProcess: async (transformedBatch) => {
            return await bulkInsert(transformedBatch)
        },
    }, { id: 'restore-table' })
}
```

What this adds over the manual approach:
- **Mid-batch yielding**: `executeTwoPhaseChunksSequentially` runs sync transforms one-by-one, flushes to the async post-processor when the time threshold is hit, and yields to the event loop. The manual `.map()` blocks until all 1000 items are transformed.
- **Batched I/O with adaptive sizing**: the number of items flushed per async call depends on how fast the transforms run, not a fixed count. Fast transforms → larger batches → fewer DB round-trips.
- **Warning logging**: alerts you when sync transforms take longer than expected.

If your per-item transform is cheap (simple property access, trivial parsing), the manual approach is better — it's simpler and the event loop isn't at risk.

## Sync transform followed by async I/O

A common pattern: CPU-intensive transformation of each item, then a bulk async operation (database insert, API call).

```ts
for (const batch of batches) {
    const transformed = batch.map((item) => cpuIntensiveTransform(item)) // sync, may block
    await bulkInsert(transformed) // async, yields
}
```

The `await` yields to the event loop, but only *after* the entire `.map()` completes. If the batch has thousands of items with heavy transforms, that `.map()` can block for 20-50ms.

### Recommended: manual threshold-based flushing

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
        }
    }
    if (pending.length > 0) await insertFn(pending)
}
```

This is straightforward and works well for a one-off case. The async `insertFn` call naturally yields to the event loop.

### With butter-spread: two-phase execution

`executeTwoPhaseChunksSequentially` encapsulates the same flush-on-threshold pattern. For a single call site, it offers little over the manual version. The value is in two concrete situations:

**Multiple two-phase pipelines with consistent behavior.** If you're restoring 10+ database tables, each with its own sync transform and bulk insert, the manual approach means 10 copies of the flushing logic with independently chosen thresholds. `executeTwoPhaseChunksSequentially` gives you one shared implementation with the same `ExecutionOptions` interface used across all call sites.

**Production observability.** The built-in warning logging tells you when sync transforms are taking longer than expected, which processor triggered it, and how many items were in the batch. With the manual approach, you'd add this instrumentation yourself — and likely only after an incident.

```ts
import { executeTwoPhaseChunksSequentially } from 'butter-spread'

const results = await executeTwoPhaseChunksSequentially(jsonlLines, {
    syncTransform: (line) => {
        const parsed = JSON.parse(line)
        return remapIds(parsed, idMapping)
    },
    asyncPostProcess: async (batch) => {
        return await db.insert(tableName).values(batch).returning()
    },
}, {
    id: 'restore-translations',
    executeSynchronouslyThresholdInMsecs: 15,
    warningThresholdInMsecs: 30,
})
```

If you have one or two pipelines and don't need warning logging, the manual version is simpler and has no dependency cost.

## Mixed sync/async processing

Sometimes a processor is synchronous for most inputs but needs to go async for others — e.g., a cache that hits memory for most lookups but falls back to a database.

The straightforward approach is to always `await`:

```ts
for (const key of keys) {
    results.push(await lookup(key)) // always yields, even on sync cache hits
}
```

This is correct but yields to the event loop on every iteration, even when `lookup` returns synchronously. In a tight loop over thousands of keys where 95% are cache hits, the unnecessary yielding adds measurable overhead.

`executeMixedChunksSequentially` detects whether each call returns a value or a Promise. Sync returns accumulate without yielding; async returns naturally yield and reset counters:

```ts
import { chunk, executeMixedChunksSequentially } from 'butter-spread'

const chunks = chunk(keys, 50)
const results = await executeMixedChunksSequentially(chunks, (keyBatch) => {
    const allCached = keyBatch.every((key) => cache.has(key))
    if (allCached) {
        return keyBatch.map((key) => cache.get(key))
    }
    return fetchFromDatabase(keyBatch)
}, {
    id: 'cache-lookup',
})
```

This only matters when the sync path is hot (many cache hits) and the loop is large. If most calls go async anyway, the always-`await` approach is simpler and the overhead difference is negligible.

## Further reading

- [Don't Block the Event Loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) — Node.js guide on event loop starvation, partitioning, and offloading
- [The Node.js Event Loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick) — How the event loop, timers, `setImmediate`, and `process.nextTick` work
- [Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams) — Node.js guide on stream backpressure, `highWaterMark`, and the `drain` event
- [piscina](https://github.com/piscinajs/piscina) — Worker thread pool for CPU-intensive tasks that exceed what chunking on the main thread can handle
