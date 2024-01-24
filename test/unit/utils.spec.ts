import { chunks, deepEqual } from '../../src/logic/utils'

describe('utils', function () {
  describe('deepEqual', function () {
    it('should return true for equal objects', () => {
      const obj1 = {
        a: 1,
        b: {
          c: 2,
          d: [3, 4]
        }
      }

      const obj2 = {
        a: 1,
        b: {
          c: 2,
          d: [3, 4]
        }
      }

      expect(deepEqual(obj1, obj2)).toBe(true)
    })

    it('should return false for different objects', () => {
      expect(
        deepEqual(
          {
            a: 1,
            b: {
              c: 2,
              d: [3, 4]
            }
          },
          {
            a: 1,
            b: {
              c: 2,
              d: [3, 5] // Different value here
            }
          }
        )
      ).toBe(false)

      expect(
        deepEqual(
          {
            a: 1
          },
          {
            a: 1,
            b: {}
          }
        )
      ).toBe(false)
    })

    it('should handle simple values', () => {
      expect(deepEqual(42, 42)).toBe(true)
      expect(deepEqual(42, '42')).toBe(false)
    })

    it('should handle null and undefined', () => {
      expect(deepEqual(null, null)).toBe(true)
      expect(deepEqual(undefined, undefined)).toBe(true)
      expect(deepEqual(null, undefined)).toBe(false)
    })
  })

  describe('chunks', function () {
    const names: string[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']

    it('returns an empty array for an empty request', async () => {
      expect(chunks([], 1)).toEqual([])
      expect(chunks([], 10)).toEqual([])
    })

    it('returns elements in chunks of the requested size', async () => {
      expect(chunks(names, 1)).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h'], ['i']])
      expect(chunks(names, 2)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h'], ['i']])
      expect(chunks(names, 3)).toEqual([
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
        ['g', 'h', 'i']
      ])
      expect(chunks(names, 4)).toEqual([['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h'], ['i']])
      expect(chunks(names, 5)).toEqual([
        ['a', 'b', 'c', 'd', 'e'],
        ['f', 'g', 'h', 'i']
      ])
      expect(chunks(names, 6)).toEqual([
        ['a', 'b', 'c', 'd', 'e', 'f'],
        ['g', 'h', 'i']
      ])
      expect(chunks(names, 7)).toEqual([
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        ['h', 'i']
      ])
      expect(chunks(names, 8)).toEqual([['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['i']])
      expect(chunks(names, 9)).toEqual([['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']])
      expect(chunks(names, 10)).toEqual([['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']])
    })
  })
})
