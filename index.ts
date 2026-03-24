export { defaultLogger } from './src/logger'
export {
  executeSyncChunksSequentially,
  executeMixedChunksSequentially,
  executeTwoPhaseChunksSequentially,
} from './src/butterSpread'
export { chunk } from './src/arrayUtils'
export { splitTextPreserveWords, getSlicePreserveWords } from './src/stringUtils'
export { batchFromStream, drainAwareWrite } from './src/streamUtils'

export type { Logger, LogFn } from './src/logger'
export type {
  ExecutionOptions,
  SyncProcessor,
  MixedProcessor,
  TwoPhaseProcessor,
} from './src/butterSpread'
