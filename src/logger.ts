export type LogFn = {
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional
  <T extends object>(obj: T, msg?: string, ...args: any[]): void
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional
  (obj: unknown, msg?: string, ...args: any[]): void
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional
  (msg: string, ...args: any[]): void
}

/**
 * Minimal logger interface used for emitting threshold-exceeded warnings.
 * The shape is intentionally pino-compatible so common structured loggers can be
 * passed in directly.
 */
export type Logger = {
  warn: LogFn
}

/**
 * Default logger used by the executors when no `logger` option is passed. Backed by
 * `console.warn` — only the `warn` method is exposed (the rest of `console` is not
 * part of the surface area).
 *
 * The wrapper resolves `console.warn` at call time so test spies on `console.warn`
 * (and any later console replacement) are picked up.
 */
export const defaultLogger: Logger = {
  // biome-ignore lint/suspicious/noExplicitAny: matches the LogFn overloaded signature
  warn: ((...args: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: pass-through to console.warn
    ;(console.warn as (...a: any[]) => void)(...args)
  }) as LogFn,
}
