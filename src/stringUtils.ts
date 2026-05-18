/**
 * Finds the position to cut a segment of `fullText` that starts at `startPos` and
 * is at most `maxLength` characters long, preferring whitespace boundaries. Walks
 * back over consecutive trailing spaces so the resulting substring never ends with
 * whitespace.
 */
function findSegmentEnd(fullText: string, startPos: number, maxLength: number): number {
  const endPos = Math.min(startPos + maxLength, fullText.length)
  if (endPos >= fullText.length) {
    return endPos
  }

  let spacePos = fullText.lastIndexOf(' ', endPos)
  if (spacePos === -1 || spacePos <= startPos) {
    // No space within the window — extend to the next space (or to end)
    spacePos = fullText.indexOf(' ', endPos)
    return spacePos === -1 ? fullText.length : spacePos
  }

  // Walk back over consecutive spaces so the segment doesn't end with whitespace
  while (spacePos > startPos && fullText[spacePos - 1] === ' ') {
    spacePos--
  }
  return spacePos
}

/**
 * Splits `fullText` into segments no longer than `maxLength` characters, trying to
 * split at whitespace so words are preserved across segments. Words longer than
 * `maxLength` are emitted on their own (the function never breaks a word in half).
 *
 * Consecutive whitespace at split points is collapsed: emitted segments are
 * trimmed of leading and trailing spaces.
 */
export function splitTextPreserveWords(fullText: string, maxLength: number): string[] {
  const result: string[] = []
  let startPos = 0

  while (startPos < fullText.length) {
    // Skip leading whitespace so segments never start with a space
    while (startPos < fullText.length && fullText[startPos] === ' ') {
      startPos++
    }
    if (startPos >= fullText.length) break

    const endPos = findSegmentEnd(fullText, startPos, maxLength)
    result.push(fullText.substring(startPos, endPos))
    startPos = endPos + (fullText[endPos] === ' ' ? 1 : 0)
  }

  return result
}

/**
 * Returns a single slice of `fullText` starting at `startPos` (default 0), at most
 * `sliceSize` characters long, ending at a whitespace boundary when possible. Words
 * longer than `sliceSize` are returned on their own.
 *
 * `startPos` is expected to coincide with a word boundary (for example, the index
 * returned as the end of a previous slice). If it lands mid-word, the returned
 * slice will start mid-word too.
 */
export function getSlicePreserveWords(
  fullText: string,
  sliceSize: number,
  _startPos?: number,
): string {
  const startPos = _startPos ?? 0
  const endPos = findSegmentEnd(fullText, startPos, sliceSize)
  return fullText.substring(startPos, endPos)
}
