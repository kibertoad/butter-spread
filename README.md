# butter-spread

[![npm version](http://img.shields.io/npm/v/butter-spread.svg)](https://npmjs.org/package/butter-spread)
![](https://github.com/kibertoad/butter-spread/workflows/ci/badge.svg)
[![Coverage Status](https://coveralls.io/repos/kibertoad/butter-spread/badge.svg?branch=main)](https://coveralls.io/r/kibertoad/butter-spread?branch=main)

Execute chunked blocking operations in a way that won't cause event loop starvation

Note that for best performance you should use worker threads. [piscina](https://github.com/piscinajs/piscina) is a fantastic library for that. Thread management, however, comes with an overhead of its own, and is not recommended for operations that complete faster than 10 msecs. 

Rule of a thumb -  move to a separate thread anything over 10-20ms, mostly to be able to keep main thread responsive, and use no more than `cpus * 1.5` threads, rounded down. 

If you need something simpler, or have to run your app in an environment that only has a single core, look no further than this library!

Keep in mind that each following chunk of work is added to the end of the event loop task queue after previous one is finished. This potentially increases latency of processing a single batch operation while improving throughput - all new work that was received after first chunk started processing will be completed before second chunk will be processed, and if there are multiple `butter-spread`-managed operations running at the same time, processing time will be divided equally among them. This behaviour can be controlled via `executeSynchronouslyThresholdInMsecs` option, which forces execution of following chunks immediately as long as total time of current processing iteration didn't exceed given amount.

## Common usage

```ts
import { chunk, executeSyncChunksSequentially, defaultLogger } from 'butter-spread'

const chunks = chunk(someInputArray, 100)

const results = await executeSyncChunksSequentially(chunks, (chunk) => { return someProcessingLogic(chunk) }, {
    id: 'Some blocking operation', // this is used for logging purposes if threshold is exceeded
    logger: defaultLogger,
    warningThresholdInMsecs: 20, // warning will be logged if any single iteration (which blocks the loop) will take longer than that
    executeSynchronouslyThresholdInMsecs: 10 // if total execution of all chunks in this iteration took less than this amount of time, next chunk will be processed immediately synchronously and not deferred
})
```

