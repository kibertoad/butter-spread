import { type Mock, vitest } from 'vitest'
import type { Logger } from '../../src/logger'

export type SpyLogger = Logger & { warn: Mock<(...args: unknown[]) => void> }

/** Logger whose `warn` is a vitest mock, so tests can assert on emitted warnings. */
export function spyLogger(): SpyLogger {
  return { warn: vitest.fn<(...args: unknown[]) => void>() }
}
