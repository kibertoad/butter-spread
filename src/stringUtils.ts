export function splitTextPreserveWords(fullText: string, maxLength: number): string[] {
  const result = []
  let startPos = 0

  while (startPos < fullText.length) {
    let endPos = Math.min(startPos + maxLength, fullText.length)
    if (endPos < fullText.length) {
      let spacePos = fullText.lastIndexOf(' ', endPos)
      if (spacePos === -1 || spacePos <= startPos) {
        // No spaces found, find the next space after the maxLength
        spacePos = fullText.indexOf(' ', endPos)
        endPos = spacePos === -1 ? fullText.length : spacePos
      } else {
        // Space found before maxLength, split at the space
        endPos = spacePos
      }
    }

    result.push(fullText.substring(startPos, endPos))
    startPos = endPos + (fullText[endPos] === ' ' ? 1 : 0)
  }

  return result
}

export function getSlicePreserveWords(
  fullText: string,
  sliceSize: number,
  _startPos?: number,
): string {
  const startPos = _startPos ?? 0

  let endPos = Math.min(startPos + sliceSize, fullText.length)
  if (endPos < fullText.length) {
    let spacePos = fullText.lastIndexOf(' ', endPos)
    if (spacePos === -1 || spacePos <= startPos) {
      // No spaces found, find the next space after the maxLength
      spacePos = fullText.indexOf(' ', endPos)
      endPos = spacePos === -1 ? fullText.length : spacePos
    } else {
      // Space found before maxLength, split at the space
      endPos = spacePos
    }
  }

  return fullText.substring(startPos, endPos)
}
