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
  })
})
