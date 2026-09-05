/**
 * Blocks the event loop for at least `ms` milliseconds using a busy-wait on the
 * monotonic clock. Predictable regardless of machine speed, unlike real workloads.
 */
export function cpuBurn(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    /* busy */
  }
}

/** Builds a synchronous processor that burns `ms` per chunk and returns a marker. */
export function burningProcessor(ms: number) {
  let calls = 0
  const processor = (chunk: number): string => {
    calls++
    cpuBurn(ms)
    return `processed-${chunk}`
  }
  return { processor, calls: () => calls }
}

export const WARNING_MESSAGE =
  /^Execution "([^"]+)" has exceeded the threshold, took (\d+) msecs for a single iteration. (\d+) chunks were processed. Last chunk took (\d+) msecs for (\d+) elements.$/
