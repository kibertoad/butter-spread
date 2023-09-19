export function chunk<T>(array: T[], chunkSize: number): T[][] {
  const length = array.length
  if (!length || chunkSize < 1) {
    return []
  }
  let index = 0
  let resIndex = 0
  const result = new Array(Math.ceil(length / chunkSize))

  while (index < length) {
    result[resIndex++] = array.slice(index, (index += chunkSize))
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return result
}

export function splitString(str: string, length: number) {
  let result = []
  let startPos = 0

  while (startPos < str.length) {
    let endPos = startPos + length

    if (endPos < str.length) {
      let spacePos = str.lastIndexOf(' ', endPos)
      endPos = spacePos > startPos ? spacePos : endPos
    }

    result.push(str.substring(startPos, endPos))
    startPos = endPos + 1
  }

  return result
}
