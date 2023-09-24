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

## Common usage

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

