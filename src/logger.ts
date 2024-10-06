export type LogFn = {
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional
  <T extends object>(obj: T, msg?: string, ...args: any[]): void
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional
  (obj: unknown, msg?: string, ...args: any[]): void
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional
  (msg: string, ...args: any[]): void
}

export type Logger = {
  warn: LogFn
}

export const defaultLogger: Logger = console
