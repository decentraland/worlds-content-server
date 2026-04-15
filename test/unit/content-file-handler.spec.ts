import { Readable } from 'stream'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { getContentFile, parseRangeHeader } from '../../src/controllers/handlers/content-file-handler'
import { HandlerContextWithPath } from '../../src/types'
import { ContentItem, IContentStorageComponent } from '@dcl/catalyst-storage'

describe('parseRangeHeader', () => {
  const fileSize = 1000

  describe('when the range has start and end', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=0-499', fileSize)
    })

    it('should return the parsed start and end', () => {
      expect(result).toEqual({ kind: 'ok', start: 0, end: 499 })
    })
  })

  describe('when the range has only a start', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=500-', fileSize)
    })

    it('should default end to the last byte', () => {
      expect(result).toEqual({ kind: 'ok', start: 500, end: 999 })
    })
  })

  describe('when the range is a suffix range', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=-200', fileSize)
    })

    it('should return the last N bytes', () => {
      expect(result).toEqual({ kind: 'ok', start: 800, end: 999 })
    })
  })

  describe('when the suffix range exceeds file size', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=-2000', fileSize)
    })

    it('should clamp start to 0', () => {
      expect(result).toEqual({ kind: 'ok', start: 0, end: 999 })
    })
  })

  describe('when the suffix is zero', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=-0', fileSize)
    })

    it('should return invalid', () => {
      expect(result).toEqual({ kind: 'invalid' })
    })
  })

  describe('when the end exceeds file size', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=900-1500', fileSize)
    })

    it('should clamp end to the last byte', () => {
      expect(result).toEqual({ kind: 'ok', start: 900, end: 999 })
    })
  })

  describe('when start equals file size', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=1000-', fileSize)
    })

    it('should return invalid', () => {
      expect(result).toEqual({ kind: 'invalid' })
    })
  })

  describe('when start is greater than end', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=500-100', fileSize)
    })

    it('should return invalid', () => {
      expect(result).toEqual({ kind: 'invalid' })
    })
  })

  describe('when the header is a multi-range request', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=0-100,200-300', fileSize)
    })

    it('should return unsupported', () => {
      expect(result).toEqual({ kind: 'unsupported' })
    })
  })

  describe('when the header has an invalid unit', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('items=0-100', fileSize)
    })

    it('should return unsupported', () => {
      expect(result).toEqual({ kind: 'unsupported' })
    })
  })

  describe('when the header has no start or end', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=-', fileSize)
    })

    it('should return unsupported', () => {
      expect(result).toEqual({ kind: 'unsupported' })
    })
  })

  describe('when requesting the first byte', () => {
    let result: ReturnType<typeof parseRangeHeader>

    beforeEach(() => {
      result = parseRangeHeader('bytes=0-0', fileSize)
    })

    it('should return a single-byte range', () => {
      expect(result).toEqual({ kind: 'ok', start: 0, end: 0 })
    })
  })

  describe('when the file size is zero', () => {
    const zeroFileSize = 0

    describe('and the range requests from the start', () => {
      let result: ReturnType<typeof parseRangeHeader>

      beforeEach(() => {
        result = parseRangeHeader('bytes=0-', zeroFileSize)
      })

      it('should return invalid', () => {
        expect(result).toEqual({ kind: 'invalid' })
      })
    })

    describe('and the range is a suffix', () => {
      let result: ReturnType<typeof parseRangeHeader>

      beforeEach(() => {
        result = parseRangeHeader('bytes=-5', zeroFileSize)
      })

      it('should return invalid', () => {
        expect(result).toEqual({ kind: 'invalid' })
      })
    })
  })
})

describe('getContentFile', () => {
  const hashId = 'bafkreiahsvnr4x4rnskhkwfbnbplkbqhzb3xagdwpyfy44lgcndmhyizde'
  const fileContent = Buffer.from('test content')

  function createContentItem(overrides: Partial<ContentItem> = {}): ContentItem {
    return {
      encoding: null,
      size: fileContent.length,
      contentSize: fileContent.length,
      asStream: jest.fn().mockResolvedValue(Readable.from(fileContent)),
      asRawStream: jest.fn().mockResolvedValue(Readable.from(fileContent)),
      ...overrides
    }
  }

  function createContext(
    storage: Partial<IContentStorageComponent>,
    rangeHeader?: string
  ): HandlerContextWithPath<'storage', '/contents/:hashId'> {
    const headers = new Headers()
    if (rangeHeader) {
      headers.set('range', rangeHeader)
    }

    return {
      url: new URL(`http://localhost/contents/${hashId}`),
      params: { hashId },
      request: { headers } as unknown as IHttpServerComponent.IRequest,
      components: { storage: storage as IContentStorageComponent }
    }
  }

  describe('when the file has compressed encoding and a Range header is sent', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      const compressedItem = createContentItem({ encoding: 'gzip' })
      storageMock = {
        fileInfo: jest.fn().mockResolvedValue({ encoding: 'gzip', size: 100, contentSize: 200 }),
        retrieve: jest.fn().mockResolvedValue(compressedItem)
      }
      response = await getContentFile(createContext(storageMock, 'bytes=0-10'))
    })

    it('should fall back to a 200 response with full content', () => {
      expect(response.status).toEqual(200)
    })

    it('should retrieve the full file without a range', () => {
      expect(storageMock.retrieve).toHaveBeenCalledWith(hashId)
    })

    it('should not advertise Accept-Ranges', () => {
      expect(response.headers!['Accept-Ranges']).toBeUndefined()
    })
  })

  describe('when the file size is null and a Range header is sent', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      const item = createContentItem({ size: null })
      storageMock = {
        fileInfo: jest.fn().mockResolvedValue({ encoding: null, size: null, contentSize: null }),
        retrieve: jest.fn().mockResolvedValue(item)
      }
      response = await getContentFile(createContext(storageMock, 'bytes=0-10'))
    })

    it('should fall back to a 200 response with full content', () => {
      expect(response.status).toEqual(200)
    })

    it('should retrieve the full file without a range', () => {
      expect(storageMock.retrieve).toHaveBeenCalledWith(hashId)
    })
  })

  describe('when a valid Range header is sent', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      const rangedItem = createContentItem({ size: 5 })
      storageMock = {
        fileInfo: jest.fn().mockResolvedValue({ encoding: null, size: fileContent.length, contentSize: fileContent.length }),
        retrieve: jest.fn().mockResolvedValue(rangedItem)
      }
      response = await getContentFile(createContext(storageMock, 'bytes=0-4'))
    })

    it('should respond with 206', () => {
      expect(response.status).toEqual(206)
    })

    it('should retrieve with the correct range', () => {
      expect(storageMock.retrieve).toHaveBeenCalledWith(hashId, { start: 0, end: 4 })
    })

    it('should include the Content-Range header with the total file size', () => {
      expect((response.headers as Record<string, string>)['Content-Range']).toEqual(
        `bytes 0-4/${fileContent.length}`
      )
    })

    it('should set Content-Length to the range size', () => {
      expect((response.headers as Record<string, string>)['Content-Length']).toEqual('5')
    })
  })

  describe('when an invalid Range header is sent', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      storageMock = {
        fileInfo: jest.fn().mockResolvedValue({ encoding: null, size: fileContent.length, contentSize: fileContent.length }),
        retrieve: jest.fn()
      }
      response = await getContentFile(createContext(storageMock, `bytes=${fileContent.length + 10}-`))
    })

    it('should respond with 416', () => {
      expect(response.status).toEqual(416)
    })

    it('should include the Content-Range header with the file size', () => {
      expect((response.headers as Record<string, string>)['Content-Range']).toEqual(
        `bytes */${fileContent.length}`
      )
    })

    it('should not call retrieve', () => {
      expect(storageMock.retrieve).not.toHaveBeenCalled()
    })
  })

  describe('when no Range header is sent', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      const item = createContentItem()
      storageMock = {
        fileInfo: jest.fn(),
        retrieve: jest.fn().mockResolvedValue(item)
      }
      response = await getContentFile(createContext(storageMock))
    })

    it('should respond with 200', () => {
      expect(response.status).toEqual(200)
    })

    it('should retrieve without a range', () => {
      expect(storageMock.retrieve).toHaveBeenCalledWith(hashId)
    })

    it('should not call fileInfo', () => {
      expect(storageMock.fileInfo).not.toHaveBeenCalled()
    })
  })
})
