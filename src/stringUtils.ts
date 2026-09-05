/** Matches a single whitespace character (space, tab, newline, and Unicode spaces). */
const WHITESPACE = /\s/

function isWhitespaceAt(text: string, index: number): boolean {
  return WHITESPACE.test(text[index])
}

function assertMaxLength(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${name} must be a finite number >= 1, received ${String(value)}`)
  }
}

/**
 * Finds the position to cut a segment of `fullText` that starts at `startPos` and
 * is at most `maxLength` characters long, preferring whitespace boundaries. Walks
 * back over consecutive trailing whitespace so the resulting substring never ends
 * with whitespace.
 */
function findSegmentEnd(fullText: string, startPos: number, maxLength: number): number {
  const endPos = Math.min(startPos + Math.trunc(maxLength), fullText.length)
  if (endPos >= fullText.length) {
    return endPos
  }

  // Look for the last whitespace within the window (inclusive of `endPos`, since a
  // whitespace character right after the window still marks a clean boundary)
  let spacePos = -1
  for (let i = endPos; i > startPos; i--) {
    if (isWhitespaceAt(fullText, i)) {
      spacePos = i
      break
    }
  }

  if (spacePos === -1) {
    // No whitespace within the window — extend to the next whitespace (or to end)
    for (let i = endPos; i < fullText.length; i++) {
      if (isWhitespaceAt(fullText, i)) {
        return i
      }
    }
    return fullText.length
  }

  // Walk back over consecutive whitespace so the segment doesn't end with it
  while (spacePos > startPos && isWhitespaceAt(fullText, spacePos - 1)) {
    spacePos--
  }
  return spacePos
}

function skipWhitespace(fullText: string, startPos: number): number {
  let pos = startPos
  while (pos < fullText.length && isWhitespaceAt(fullText, pos)) {
    pos++
  }
  return pos
}

/**
 * Splits `fullText` into segments no longer than `maxLength` characters, trying to
 * split at whitespace (spaces, tabs, line breaks) so words are preserved across
 * segments. Words longer than `maxLength` are emitted on their own (the function
 * never breaks a word in half).
 *
 * Whitespace at split points is collapsed: emitted segments never start or end with
 * whitespace. Whitespace inside a segment is preserved as-is.
 *
 * @throws RangeError if `maxLength` is not a finite number >= 1.
 */
export function splitTextPreserveWords(fullText: string, maxLength: number): string[] {
  assertMaxLength('maxLength', maxLength)
  const result: string[] = []
  let startPos = 0

  while (startPos < fullText.length) {
    // Skip leading whitespace so segments never start with it
    startPos = skipWhitespace(fullText, startPos)
    if (startPos >= fullText.length) break

    const endPos = findSegmentEnd(fullText, startPos, maxLength)
    result.push(fullText.substring(startPos, endPos))
    startPos = endPos
  }

  return result
}

/**
 * Returns a single slice of `fullText` starting at `startPos` (default 0), at most
 * `sliceSize` characters long, ending at a whitespace boundary when possible. Words
 * longer than `sliceSize` are returned on their own.
 *
 * Leading whitespace at `startPos` is skipped, so `startPos` may point either at the
 * first character of a word or at the whitespace that precedes it. If it lands
 * mid-word, the returned slice starts mid-word too: this function does not snap
 * forward to the next word boundary. To iterate over a whole text use
 * {@link splitTextPreserveWords}, which tracks positions for you.
 *
 * @throws RangeError if `sliceSize` is not a finite number >= 1.
 */
export function getSlicePreserveWords(
  fullText: string,
  sliceSize: number,
  _startPos?: number,
): string {
  assertMaxLength('sliceSize', sliceSize)
  const startPos = skipWhitespace(fullText, Math.max(0, _startPos ?? 0))
  const endPos = findSegmentEnd(fullText, startPos, sliceSize)
  return fullText.substring(startPos, endPos)
}
