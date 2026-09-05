/**
 * Splits `array` into consecutive sub-arrays of length `chunkSize` (the last chunk
 * may be smaller). Fractional sizes are truncated to an integer. Returns an empty
 * array if `array` is empty or if the (truncated) `chunkSize` is not a positive
 * finite number.
 */
export function chunk<T>(array: readonly T[], chunkSize: number): T[][] {
  const length = array.length
  const size = Math.trunc(chunkSize)
  if (!length || !Number.isFinite(size) || size < 1) {
    return []
  }
  let index = 0
  let resIndex = 0
  const result = new Array<T[]>(Math.ceil(length / size))

  while (index < length) {
    result[resIndex++] = array.slice(index, (index += size))
  }

  return result
}
