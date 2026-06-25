import { Readable } from 'stream'
import { IHttpServerComponent } from '@dcl/core-commons'
import {
  availableContentHandler,
  getContentFile,
  MAX_AVAILABLE_CONTENT_CIDS,
  parseRangeHeader
} from '../../src/controllers/handlers/content-file-handler'
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

  // Minimal but valid magic bytes so file-type recognizes the content.
  const mp4Content = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00, 0x6d, 0x70, 0x34,
    0x32, 0x69, 0x73, 0x6f, 0x6d
  ])

  function createContentItem(content: Buffer = fileContent, overrides: Partial<ContentItem> = {}): ContentItem {
    return {
      encoding: null,
      size: content.length,
      contentSize: content.length,
      // Fresh streams per call so detection and body reads don't share a consumed stream.
      asStream: jest.fn().mockImplementation(async () => Readable.from(content)),
      asRawStream: jest.fn().mockImplementation(async () => Readable.from(content)),
      ...overrides
    }
  }

  function createContext(
    storage: Partial<IContentStorageComponent>,
    rangeHeader?: string,
    keyOverride?: string
  ): HandlerContextWithPath<'storage', '/contents/:hashId'> {
    const headers = new Headers()
    if (rangeHeader) {
      headers.set('range', rangeHeader)
    }

    const key = keyOverride ?? hashId
    return {
      url: new URL(`http://localhost/contents/${key}`),
      params: { hashId: key },
      request: { headers } as unknown as IHttpServerComponent.IRequest,
      components: { storage: storage as IContentStorageComponent }
    }
  }

  describe('when the file has compressed encoding and a Range header is sent', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>
    let compressedItem: ContentItem

    beforeEach(async () => {
      compressedItem = createContentItem(fileContent, { encoding: 'gzip' })
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

    it('should skip MIME detection and fall back to application/octet-stream', () => {
      expect((response.headers as Record<string, string>)['Content-Type']).toEqual('application/octet-stream')
    })

    it('should not read the raw stream to sniff a compressed item', () => {
      // asRawStream is called once for the body, never a second time for detection (which would
      // require routing a compressed stream through a gunzip pipe we cannot reliably tear down).
      expect(compressedItem.asRawStream).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the file size is null and a Range header is sent', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      const item = createContentItem(fileContent, { size: null })
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
      const rangedItem = createContentItem(fileContent, { size: 5 })
      storageMock = {
        fileInfo: jest
          .fn()
          .mockResolvedValue({ encoding: null, size: fileContent.length, contentSize: fileContent.length }),
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
      expect((response.headers as Record<string, string>)['Content-Range']).toEqual(`bytes 0-4/${fileContent.length}`)
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
        fileInfo: jest
          .fn()
          .mockResolvedValue({ encoding: null, size: fileContent.length, contentSize: fileContent.length }),
        retrieve: jest.fn()
      }
      response = await getContentFile(createContext(storageMock, `bytes=${fileContent.length + 10}-`))
    })

    it('should respond with 416', () => {
      expect(response.status).toEqual(416)
    })

    it('should include the Content-Range header with the file size', () => {
      expect((response.headers as Record<string, string>)['Content-Range']).toEqual(`bytes */${fileContent.length}`)
    })

    it('should not call retrieve', () => {
      expect(storageMock.retrieve).not.toHaveBeenCalled()
    })
  })

  describe('when retrieve throws a RangeError', () => {
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      const storageMock: Partial<IContentStorageComponent> = {
        fileInfo: jest
          .fn()
          .mockResolvedValue({ encoding: null, size: fileContent.length, contentSize: fileContent.length }),
        retrieve: jest.fn().mockRejectedValue(new RangeError('Range start 0 exceeds size 0'))
      }
      response = await getContentFile(createContext(storageMock, 'bytes=0-4'))
    })

    it('should respond with 416', () => {
      expect(response.status).toEqual(416)
    })

    it('should include the Content-Range header with the file size', () => {
      expect((response.headers as Record<string, string>)['Content-Range']).toEqual(`bytes */${fileContent.length}`)
    })
  })

  describe('when retrieve throws a non-RangeError', () => {
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(() => {
      storageMock = {
        fileInfo: jest
          .fn()
          .mockResolvedValue({ encoding: null, size: fileContent.length, contentSize: fileContent.length }),
        retrieve: jest.fn().mockRejectedValue(new Error('connection lost'))
      }
    })

    it('should re-throw the error', async () => {
      await expect(getContentFile(createContext(storageMock, 'bytes=0-4'))).rejects.toThrow('connection lost')
    })
  })

  describe('when fileInfo succeeds but retrieve returns null', () => {
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      const storageMock: Partial<IContentStorageComponent> = {
        fileInfo: jest
          .fn()
          .mockResolvedValue({ encoding: null, size: fileContent.length, contentSize: fileContent.length }),
        retrieve: jest.fn().mockResolvedValue(undefined)
      }
      response = await getContentFile(createContext(storageMock, 'bytes=0-4'))
    })

    it('should respond with 404', () => {
      expect(response.status).toEqual(404)
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

  describe('when serving full content of a recognizable file type', () => {
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      const item = createContentItem(mp4Content)
      const storageMock: Partial<IContentStorageComponent> = {
        fileInfo: jest.fn(),
        retrieve: jest.fn().mockResolvedValue(item)
      }
      response = await getContentFile(createContext(storageMock))
    })

    it('should set the Content-Type to the detected MIME type', () => {
      expect((response.headers as Record<string, string>)['Content-Type']).toEqual('video/mp4')
    })
  })

  describe('when serving full content of an unrecognizable file type', () => {
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      const item = createContentItem() // plain text: no recognizable magic bytes
      const storageMock: Partial<IContentStorageComponent> = {
        fileInfo: jest.fn(),
        retrieve: jest.fn().mockResolvedValue(item)
      }
      response = await getContentFile(createContext(storageMock))
    })

    it('should fall back to application/octet-stream', () => {
      expect((response.headers as Record<string, string>)['Content-Type']).toEqual('application/octet-stream')
    })
  })

  describe('when serving a byte range of a recognizable file type', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      // The requested range starts mid-file; the type must still be detected from the file start.
      storageMock = {
        fileInfo: jest.fn().mockResolvedValue({ encoding: null, size: 5000, contentSize: 5000 }),
        retrieve: jest
          .fn()
          .mockImplementation(async (_id: string, range?: { start: number; end: number }) =>
            createContentItem(mp4Content, { size: range ? range.end - range.start + 1 : mp4Content.length })
          )
      }
      response = await getContentFile(createContext(storageMock, 'bytes=1000-2000'))
    })

    it('should respond with 206', () => {
      expect(response.status).toEqual(206)
    })

    it('should sniff the MIME type from the start of the file', () => {
      expect(storageMock.retrieve).toHaveBeenCalledWith(hashId, { start: 0, end: 4099 })
    })

    it('should set the Content-Type to the detected MIME type', () => {
      expect((response.headers as Record<string, string>)['Content-Type']).toEqual('video/mp4')
    })
  })

  describe('when the content key is a SHA-256 hex digest', () => {
    const sha256Key = 'a'.repeat(64)
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      const item = createContentItem()
      storageMock = {
        fileInfo: jest.fn(),
        retrieve: jest.fn().mockResolvedValue(item)
      }
      response = await getContentFile(createContext(storageMock, undefined, sha256Key))
    })

    it('should respond with 200', () => {
      expect(response.status).toEqual(200)
    })

    it('should retrieve the file by its SHA-256 key', () => {
      expect(storageMock.retrieve).toHaveBeenCalledWith(sha256Key)
    })
  })

  describe('when the content key is neither a CIDv1 nor a SHA-256 digest', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      storageMock = {
        fileInfo: jest.fn(),
        retrieve: jest.fn()
      }
      response = await getContentFile(createContext(storageMock, undefined, 'not-a-valid-key'))
    })

    it('should respond with 400', () => {
      expect(response.status).toEqual(400)
    })

    it('should not call retrieve', () => {
      expect(storageMock.retrieve).not.toHaveBeenCalled()
    })
  })
})

describe('availableContentHandler', () => {
  const validCid = 'bafkreiahsvnr4x4rnskhkwfbnbplkbqhzb3xagdwpyfy44lgcndmhyizde'

  function createContext(
    storage: Partial<IContentStorageComponent>,
    search: string
  ): HandlerContextWithPath<'storage', '/content/available-content'> {
    return {
      url: new URL(`http://localhost/available-content${search}`),
      params: {},
      request: { headers: new Headers() } as unknown as IHttpServerComponent.IRequest,
      components: { storage: storage as IContentStorageComponent }
    }
  }

  describe('when no cid is provided', () => {
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(() => {
      storageMock = {
        existMultiple: jest.fn()
      }
    })

    it('should reject the request', async () => {
      await expect(availableContentHandler(createContext(storageMock, ''))).rejects.toThrow(
        'At least one cid query parameter is required.'
      )
    })
  })

  describe('when a cid is invalid', () => {
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(() => {
      storageMock = {
        existMultiple: jest.fn()
      }
    })

    it('should reject the request', async () => {
      await expect(availableContentHandler(createContext(storageMock, '?cid=invalid'))).rejects.toThrow(
        'Invalid cid format.'
      )
    })
  })

  describe('when too many cids are provided', () => {
    let storageMock: Partial<IContentStorageComponent>
    let search: string

    beforeEach(() => {
      storageMock = {
        existMultiple: jest.fn()
      }
      search = `?${Array.from({ length: MAX_AVAILABLE_CONTENT_CIDS + 1 }, () => `cid=${validCid}`).join('&')}`
    })

    it('should reject the request', async () => {
      await expect(availableContentHandler(createContext(storageMock, search))).rejects.toThrow(
        `Too many cid query parameters. Maximum allowed is ${MAX_AVAILABLE_CONTENT_CIDS}.`
      )
    })
  })

  describe('when all cids are valid', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>

    beforeEach(async () => {
      storageMock = {
        existMultiple: jest.fn().mockResolvedValue(new Map([[validCid, true]]))
      }
      response = await availableContentHandler(createContext(storageMock, `?cid=${validCid}`))
    })

    it('should return availability for the requested cids', () => {
      expect(response.body).toEqual([{ cid: validCid, available: true }])
    })
  })

  describe('when the maximum number of cids is provided', () => {
    let response: IHttpServerComponent.IResponse
    let storageMock: Partial<IContentStorageComponent>
    let search: string

    beforeEach(async () => {
      storageMock = {
        existMultiple: jest.fn().mockResolvedValue(new Map([[validCid, true]]))
      }
      search = `?${Array.from({ length: MAX_AVAILABLE_CONTENT_CIDS }, () => `cid=${validCid}`).join('&')}`

      response = await availableContentHandler(createContext(storageMock, search))
    })

    it('should accept the request', () => {
      expect(response.body).toEqual([{ cid: validCid, available: true }])
    })
  })
})
