import { describe, expect, it } from 'vitest'
import { getSlicePreserveWords, splitTextPreserveWords } from '../src/stringUtils'

describe('stringUtils', () => {
  describe('splitTextPreserveWords', () => {
    it('returns full text if it is within limit', () => {
      const result = splitTextPreserveWords('My text is this', 20)

      expect(result).toEqual(['My text is this'])
    })

    it('cuts text, preserves words if below limit, with exact length match', () => {
      const result = splitTextPreserveWords('My text is this', 7)

      expect(result).toEqual(['My text', 'is this'])
    })

    it('cuts text, preserves words if below limit, with a length difference', () => {
      const result = splitTextPreserveWords('My text is this', 9)

      expect(result).toEqual(['My text', 'is this'])
    })

    it('Does best possible effort if there are words longer than max length', () => {
      const result = splitTextPreserveWords('My text is this', 3)

      expect(result).toEqual(['My', 'text', 'is', 'this'])
    })

    it('Does best possible effort if there are words longer than max length, does not try to include parts before or after', () => {
      const result = splitTextPreserveWords('My text is this', 5)

      expect(result).toEqual(['My', 'text', 'is', 'this'])
    })

    it('Does best possible effort if all words longer than max length', () => {
      const result = splitTextPreserveWords('My text is this', 1)

      expect(result).toEqual(['My', 'text', 'is', 'this'])
    })

    it('Does best possible effort if no spaces are available at all', () => {
      const result = splitTextPreserveWords('Mytextisthis.jpg', 1)

      expect(result).toEqual(['Mytextisthis.jpg'])
    })

    it('collapses consecutive whitespace at split points', () => {
      // Old behavior would emit 'foo ' (trailing space) for the first segment
      const result = splitTextPreserveWords('foo  bar', 5)

      expect(result).toEqual(['foo', 'bar'])
    })

    it('handles multiple consecutive spaces between words', () => {
      const result = splitTextPreserveWords('foo   bar baz', 5)

      expect(result).toEqual(['foo', 'bar', 'baz'])
    })

    it('treats tabs and line breaks as word boundaries', () => {
      const result = splitTextPreserveWords('foo\tbar\nbaz qux', 5)

      expect(result).toEqual(['foo', 'bar', 'baz', 'qux'])
    })

    it('preserves whitespace inside a segment', () => {
      const result = splitTextPreserveWords('foo\tbar\nbaz qux', 7)

      expect(result).toEqual(['foo\tbar', 'baz qux'])
    })

    it('ignores leading and trailing whitespace of the input', () => {
      const result = splitTextPreserveWords('  foo bar  \n', 3)

      expect(result).toEqual(['foo', 'bar'])
    })

    it('trims trailing whitespace from the final segment that fits the limit', () => {
      expect(splitTextPreserveWords('foo  ', 5)).toEqual(['foo'])
      expect(splitTextPreserveWords('foo bar\t', 20)).toEqual(['foo bar'])
    })

    it('keeps a fitting remainder in one segment even when it contains whitespace', () => {
      expect(splitTextPreserveWords('foo bar', 10)).toEqual(['foo bar'])
    })

    it('returns empty array for empty input', () => {
      expect(splitTextPreserveWords('', 5)).toEqual([])
    })

    it('truncates a fractional maxLength', () => {
      expect(splitTextPreserveWords('ab cd ef', 5.9)).toEqual(['ab cd', 'ef'])
    })

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('throws RangeError for %s maxLength instead of looping forever', (_label, maxLength) => {
      expect(() => splitTextPreserveWords('foo bar', maxLength)).toThrow(RangeError)
    })
  })

  describe('getSlicePreserveWords', () => {
    it('returns full text if it is within limit', () => {
      const result = getSlicePreserveWords('My text is this', 20)

      expect(result).toBe('My text is this')
    })

    it('returns full text if it is within limit, from the middle', () => {
      const result = getSlicePreserveWords('My text is this', 20, 3)

      expect(result).toBe('text is this')
    })

    it('cuts text, preserves words if below limit, with exact length match', () => {
      const result = getSlicePreserveWords('My text is this', 7)

      expect(result).toBe('My text')
    })

    it('cuts text, preserves words if below limit, with exact length match, from the middle', () => {
      const result = getSlicePreserveWords('My text is this', 7, 3)

      expect(result).toBe('text is')
    })

    it('cuts text, preserves words if below limit, with a length difference', () => {
      const result = getSlicePreserveWords('My text is this', 9)

      expect(result).toBe('My text')
    })

    it('cuts text, preserves words if below limit, with a length difference, from the middle', () => {
      const result = getSlicePreserveWords('My text is this', 9, 3)

      expect(result).toBe('text is')
    })

    it('Does best possible effort if there are words longer than max length', () => {
      const result = getSlicePreserveWords('My text is this', 3)

      expect(result).toBe('My')
    })

    it('Does best possible effort if there are words longer than max length, from the middle', () => {
      const result = getSlicePreserveWords('My text is this', 3, 3)

      expect(result).toBe('text')
    })

    it('Does best possible effort if there are words longer than max length, does not try to include parts before or after', () => {
      const result = getSlicePreserveWords('My text is this', 5)

      expect(result).toBe('My')
    })

    it('Does best possible effort if all words longer than max length', () => {
      const result = getSlicePreserveWords('My text is this', 1)

      expect(result).toBe('My')
    })

    it('Does best possible effort if all words longer than max length, from the middle', () => {
      const result = getSlicePreserveWords('My text is this', 1, 3)

      expect(result).toBe('text')
    })

    it('Does best possible effort if no spaces are available at all', () => {
      const result = getSlicePreserveWords('Mytextisthis.jpg', 1)

      expect(result).toBe('Mytextisthis.jpg')
    })

    it('skips whitespace at startPos so a slice never starts with it', () => {
      // startPos 3 is the space after 'foo', i.e. where the previous slice ended
      const result = getSlicePreserveWords('foo bar baz', 4, 3)

      expect(result).toBe('bar')
    })

    it('skips tabs and line breaks at startPos', () => {
      const result = getSlicePreserveWords('foo\n\tbar baz', 3, 3)

      expect(result).toBe('bar')
    })

    it('trims trailing whitespace when the remainder fits the limit', () => {
      expect(getSlicePreserveWords('foo  ', 5)).toBe('foo')
      expect(getSlicePreserveWords('foo bar\n', 20)).toBe('foo bar')
    })

    it('returns empty string for whitespace-only input', () => {
      expect(getSlicePreserveWords('   ', 5)).toBe('')
    })

    it('returns empty string when startPos is past the end of the text', () => {
      expect(getSlicePreserveWords('foo bar', 3, 100)).toBe('')
    })

    it('clamps a negative startPos to 0', () => {
      expect(getSlicePreserveWords('foo bar', 3, -2)).toBe('foo')
    })

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
    ])('throws RangeError for %s sliceSize', (_label, sliceSize) => {
      expect(() => getSlicePreserveWords('foo bar', sliceSize)).toThrow(RangeError)
    })

    it('returns mid-word slice when startPos lands inside a word', () => {
      // Documented precondition: startPos should coincide with a word boundary.
      // When it doesn't, the slice starts mid-word (no attempt to snap forward).
      const result = getSlicePreserveWords('hello world', 5, 3)

      expect(result).toBe('lo')
    })
  })
})
