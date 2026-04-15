import { parseRangeHeader } from '../../src/controllers/handlers/content-file-handler'

describe('parseRangeHeader', () => {
  const fileSize = 1000

  describe('when the range has start and end', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=0-499', fileSize)
    })

    it('should return the parsed start and end', () => {
      expect(result).toEqual({ start: 0, end: 499 })
    })
  })

  describe('when the range has only a start', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=500-', fileSize)
    })

    it('should default end to the last byte', () => {
      expect(result).toEqual({ start: 500, end: 999 })
    })
  })

  describe('when the range is a suffix range', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=-200', fileSize)
    })

    it('should return the last N bytes', () => {
      expect(result).toEqual({ start: 800, end: 999 })
    })
  })

  describe('when the suffix range exceeds file size', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=-2000', fileSize)
    })

    it('should clamp start to 0', () => {
      expect(result).toEqual({ start: 0, end: 999 })
    })
  })

  describe('when the suffix is zero', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=-0', fileSize)
    })

    it('should return null', () => {
      expect(result).toBeNull()
    })
  })

  describe('when the end exceeds file size', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=900-1500', fileSize)
    })

    it('should clamp end to the last byte', () => {
      expect(result).toEqual({ start: 900, end: 999 })
    })
  })

  describe('when start equals file size', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=1000-', fileSize)
    })

    it('should return null', () => {
      expect(result).toBeNull()
    })
  })

  describe('when start is greater than end', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=500-100', fileSize)
    })

    it('should return null', () => {
      expect(result).toBeNull()
    })
  })

  describe('when the header is a multi-range request', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=0-100,200-300', fileSize)
    })

    it('should return null', () => {
      expect(result).toBeNull()
    })
  })

  describe('when the header has an invalid unit', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('items=0-100', fileSize)
    })

    it('should return null', () => {
      expect(result).toBeNull()
    })
  })

  describe('when the header has no start or end', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=-', fileSize)
    })

    it('should return null', () => {
      expect(result).toBeNull()
    })
  })

  describe('when requesting the first byte', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=0-0', fileSize)
    })

    it('should return a single-byte range', () => {
      expect(result).toEqual({ start: 0, end: 0 })
    })
  })
})
