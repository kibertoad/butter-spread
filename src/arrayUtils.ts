/**
 * Splits `array` into consecutive sub-arrays of length `chunkSize` (the last chunk
 * may be smaller). Returns an empty array if `array` is empty or if `chunkSize` is
 * not a positive finite number.
 */
export function chunk<T>(array: T[], chunkSize: number): T[][] {
  const length = array.length
  if (!length || !Number.isFinite(chunkSize) || chunkSize < 1) {
    return []
  }
  let index = 0
  let resIndex = 0
  const result = new Array<T[]>(Math.ceil(length / chunkSize))

  while (index < length) {
    result[resIndex++] = array.slice(index, (index += chunkSize))
  }

  return result
}
