export { defaultLogger } from './src/logger'
export { executeSyncChunksSequentially, executeMixedChunksSequentially } from './src/butterSpread'
export { chunk } from './src/arrayUtils'
export { splitTextPreserveWords, getSlicePreserveWords } from './src/stringUtils'

export type { Logger, LogFn } from './src/logger'
export type { ExecutionOptions, SyncProcessor, MixedProcessor } from './src/butterSpread'
