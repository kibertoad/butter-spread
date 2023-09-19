# butter-spread

[![npm version](http://img.shields.io/npm/v/butter-spread.svg)](https://npmjs.org/package/butter-spread)
![](https://github.com/kibertoad/butter-spread/workflows/ci/badge.svg)
[![Coverage Status](https://coveralls.io/repos/kibertoad/butter-spread/badge.svg?branch=main)](https://coveralls.io/r/kibertoad/butter-spread?branch=main)

Execute chunked blocking operations in a way that won't cause event loop starvation

Note that for best performance you should use worker threads. [piscina](https://github.com/piscinajs/piscina) is a fantastic library for that. 

If, however, you need something simpler, or have to run your app in an environment that only has a single core, look no further than this library!

## Common usage

```ts
import { chunk, executeSyncChunksSequentially, defaultLogger } from 'butter-spread'

const chunks = chunk(someInputArray, 100)

const results = await executeSyncChunksSequentially(chunks, (chunk) => { return someProcessingLogic(chunk) }, {
    id: 'Some blocking operation', // this is used for logging purposes if threshold is exceeded
    logger: defaultLogger,
    warningThresholdInMsecs: 200, // warning will be logged if any single iteration (which blocks the loop) will take longer than that
})
```

