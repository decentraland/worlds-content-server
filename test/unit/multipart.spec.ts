import { Readable } from 'stream'
import FormData from 'form-data'
import { multipartParserWrapper, readUploadedFile } from '../../src/logic/multipart'

function createMultipartContext(form: FormData, overrides?: { contentLength?: string }): any {
  const headers: Record<string, string | null> = {
    'content-type': form.getHeaders()['content-type'],
    'content-length': overrides?.contentLength ?? null
  }
  return {
    request: {
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null
      },
      body: Readable.from(form.getBuffer())
    }
  }
}

describe('multipartParserWrapper', function () {
  describe('when the parsed body exceeds the maximum allowed size', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100 })
      const form = new FormData()
      form.append('file', Buffer.alloc(5000), { filename: 'big.bin' })
      context = createMultipartContext(form)
    })

    it('should reject the request', async () => {
      await expect(parse(context)).rejects.toThrow()
    })

    it('should not invoke the handler', async () => {
      await parse(context).catch(() => undefined)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('when several files each within the per-file cap exceed the maximum in aggregate', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100 })
      const form = new FormData()
      // Three 50-byte files: each is under the per-file cap (100), but together they exceed it.
      form.append('a', Buffer.alloc(50), { filename: 'a.bin' })
      form.append('b', Buffer.alloc(50), { filename: 'b.bin' })
      form.append('c', Buffer.alloc(50), { filename: 'c.bin' })
      context = createMultipartContext(form)
    })

    it('should reject the request', async () => {
      await expect(parse(context)).rejects.toThrow()
    })

    it('should not invoke the handler', async () => {
      await parse(context).catch(() => undefined)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('when the request has more files than allowed', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      parse = multipartParserWrapper(handler, { limits: { files: 1 } })
      const form = new FormData()
      form.append('a', Buffer.alloc(10), { filename: 'a.bin' })
      form.append('b', Buffer.alloc(10), { filename: 'b.bin' })
      context = createMultipartContext(form)
    })

    it('should reject the request', async () => {
      await expect(parse(context)).rejects.toThrow()
    })

    it('should not invoke the handler', async () => {
      await parse(context).catch(() => undefined)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('when the parsed body is within the maximum allowed size', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100000 })
      const form = new FormData()
      form.append('entityId', 'abc')
      form.append('file', Buffer.alloc(100), { filename: 'ok.bin' })
      context = createMultipartContext(form)
    })

    it('should invoke the handler', async () => {
      await parse(context)
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('when a file is uploaded within the limits', () => {
    let parse: (ctx: any) => Promise<any>
    let context: any
    let captured: { size: number; contents: string } | undefined

    beforeEach(() => {
      captured = undefined
      // Read the temp-backed file inside the handler, before the wrapper cleans it up.
      const handler = jest.fn(async (ctx: any) => {
        const file = ctx.formData.files['file']
        captured = { size: file.size, contents: (await readUploadedFile(file)).toString() }
        return { status: 200 }
      })
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100000 })
      const form = new FormData()
      form.append('file', Buffer.from('hello world'), { filename: 'ok.bin' })
      context = createMultipartContext(form)
    })

    it('should expose the number of bytes written to disk', async () => {
      await parse(context)
      expect(captured?.size).toBe('hello world'.length)
    })

    it('should stream the uploaded contents to a readable temp file', async () => {
      await parse(context)
      expect(captured?.contents).toBe('hello world')
    })
  })

  describe('when the request body is a web ReadableStream, as @dcl/http-server delivers it', () => {
    let parse: (ctx: any) => Promise<any>
    let context: any
    let captured: { contents: string } | undefined

    beforeEach(() => {
      captured = undefined
      const handler = jest.fn(async (ctx: any) => {
        const file = ctx.formData.files['file']
        captured = { contents: (await readUploadedFile(file)).toString() }
        return { status: 200 }
      })
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100000 })
      const form = new FormData()
      form.append('file', Buffer.from('hello world'), { filename: 'ok.bin' })
      // @dcl/http-server exposes the native request body as a web ReadableStream
      // (Readable.toWeb), not a Node Readable.
      context = {
        request: {
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? form.getHeaders()['content-type'] : null) },
          body: Readable.toWeb(Readable.from(form.getBuffer()))
        }
      }
    })

    it('should parse the uploaded file and pass it to the handler', async () => {
      const result = await parse(context)
      expect(result).toEqual({ status: 200 })
      expect(captured?.contents).toBe('hello world')
    })
  })

  describe('when the Content-Length header exceeds the maximum allowed size', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100 })
      const form = new FormData()
      form.append('file', Buffer.alloc(10), { filename: 'small.bin' })
      context = createMultipartContext(form, { contentLength: '5000' })
    })

    it('should reject the request before reading the body', async () => {
      await expect(parse(context)).rejects.toThrow('The multipart request is too large.')
    })

    it('should not invoke the handler', async () => {
      await parse(context).catch(() => undefined)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('when a form field name collides with the object prototype', () => {
    let parse: (ctx: any) => Promise<any>
    let context: any
    let captured: { protoIsNull: boolean; entityId: string[] | undefined } | undefined

    beforeEach(() => {
      captured = undefined
      const handler = jest.fn(async (ctx: any) => {
        const fields = ctx.formData.fields
        captured = { protoIsNull: Object.getPrototypeOf(fields) === null, entityId: fields['entityId']?.value }
        return { status: 200 }
      })
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100000 })
      const form = new FormData()
      // On a plain object this both mutates the prototype and crashes the field handler; on a
      // null-prototype map it is stored as an ordinary key.
      form.append('__proto__', 'polluted')
      form.append('entityId', 'abc')
      context = createMultipartContext(form)
    })

    it('should keep the parsed fields on a null-prototype object', async () => {
      await parse(context)
      expect(captured?.protoIsNull).toBe(true)
    })

    it('should still expose the legitimate fields to the handler', async () => {
      await parse(context)
      expect(captured?.entityId).toEqual(['abc'])
    })
  })

  describe('when the request body stream errors mid-upload', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100000 })
      const contentType = new FormData().getHeaders()['content-type']
      // A body that fails partway through. With `.pipe()` busboy would emit neither close nor error
      // and the wrapper would hang forever; it must reject (and clean up) instead.
      const erroringBody = new Readable({
        read() {
          this.destroy(new Error('socket hang up'))
        }
      })
      context = {
        request: {
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
          body: erroringBody
        }
      }
    })

    it('should reject the request rather than hang', async () => {
      await expect(parse(context)).rejects.toThrow()
    })

    it('should not invoke the handler', async () => {
      await parse(context).catch(() => undefined)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('when concurrent uploads would exceed the buffered-bytes budget', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let releaseFirstUpload: () => void
    let firstUploadInHandler: Promise<void>
    let firstUpload: Promise<any>

    beforeEach(async () => {
      let signalFirstInHandler: () => void
      firstUploadInHandler = new Promise<void>((resolve) => {
        signalFirstInHandler = resolve
      })
      const gate = new Promise<void>((resolve) => {
        releaseFirstUpload = resolve
      })

      handler = jest.fn(async () => {
        signalFirstInHandler()
        await gate
        return { status: 200 }
      })
      // With no Content-Length, each request reserves the full per-request limit, so a single
      // in-flight upload exhausts a budget equal to that limit.
      parse = multipartParserWrapper(handler, { maxInFlightUploadBytes: 100, maxSizeInBytes: 100 })

      const firstForm = new FormData()
      firstForm.append('file', Buffer.alloc(10), { filename: 'a.bin' })

      // Hold the single slot busy inside the handler until we release it.
      firstUpload = parse(createMultipartContext(firstForm))
      await firstUploadInHandler
    })

    afterEach(async () => {
      releaseFirstUpload()
      await firstUpload
    })

    it('should shed the extra upload with a 503 response', async () => {
      const secondForm = new FormData()
      secondForm.append('file', Buffer.alloc(10), { filename: 'b.bin' })

      const response = await parse(createMultipartContext(secondForm))

      expect(response.status).toBe(503)
    })

    it('should not invoke the handler for the shed upload', async () => {
      const secondForm = new FormData()
      secondForm.append('file', Buffer.alloc(10), { filename: 'b.bin' })

      await parse(createMultipartContext(secondForm))

      // Only the first (still-pending) upload reached the handler.
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })
})
