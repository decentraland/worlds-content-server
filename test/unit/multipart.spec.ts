import { Readable } from 'stream'
import FormData from 'form-data'
import { multipartParserWrapper } from '../../src/logic/multipart'

function createMultipartContext(form: FormData): any {
  return {
    request: {
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? form.getHeaders()['content-type'] : null)
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
})
