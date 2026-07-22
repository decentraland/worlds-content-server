import { createWriteStream as createNodeWriteStream } from 'fs'
import { access } from 'fs/promises'
import * as fsPromises from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { Readable, Writable } from 'stream'
import FormData from 'form-data'
import { hashV1 } from '@dcl/hashing'
import {
  createInFlightUploadBudget,
  InFlightUploadBudget,
  InFlightUploadBudgetSnapshot,
  multipartParserWrapper,
  readUploadedFile,
  toDeploymentFile,
  UploadedFile
} from '../../src/logic/multipart'

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

function createStalledFileBody(bytes: number): { body: Readable; contentType: string } {
  const boundary = '----StalledMultipartBoundary'
  let sent = false
  const body = new Readable({
    read() {
      if (!sent) {
        sent = true
        this.push(
          Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
            ),
            Buffer.alloc(bytes)
          ])
        )
      }
    }
  })
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

describe('multipartParserWrapper', function () {
  describe('when the parsed body exceeds the maximum allowed size', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any
    let onTelemetry: jest.Mock

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      onTelemetry = jest.fn()
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100, onTelemetry, route: 'test' })
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

    it('should report a payload-size rejection', async () => {
      await parse(context).catch(() => undefined)
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'payload_size' }))
    })
  })

  describe('when several files each within the per-file cap exceed the maximum in aggregate', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any
    let inFlightUploadBudget: InFlightUploadBudget

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      inFlightUploadBudget = createInFlightUploadBudget(100)
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100, inFlightUploadBudget })
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

    it('should release all reserved bytes and the upload slot', async () => {
      await parse(context).catch(() => undefined)
      expect(inFlightUploadBudget.snapshot()).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when the request has more files than allowed', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any
    let onTelemetry: jest.Mock

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      onTelemetry = jest.fn()
      parse = multipartParserWrapper(handler, { limits: { files: 1 }, onTelemetry, route: 'test' })
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

    it('should report an invalid-multipart rejection', async () => {
      await parse(context).catch(() => undefined)
      expect(onTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rejected', reason: 'invalid_multipart' })
      )
    })
  })

  describe('when the parsed body is within the maximum allowed size', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any
    let inFlightUploadBudget: InFlightUploadBudget

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      inFlightUploadBudget = createInFlightUploadBudget(100000)
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100000, inFlightUploadBudget })
      const form = new FormData()
      form.append('entityId', 'abc')
      form.append('file', Buffer.alloc(100), { filename: 'ok.bin' })
      context = createMultipartContext(form)
    })

    it('should invoke the handler', async () => {
      await parse(context)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('should release all reserved bytes and the upload slot', async () => {
      await parse(context)
      expect(inFlightUploadBudget.snapshot()).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when a file is uploaded within the limits', () => {
    let parse: (ctx: any) => Promise<any>
    let context: any
    let captured: { size: number; contents: string; filepath: string } | undefined

    beforeEach(() => {
      captured = undefined
      // Read the temp-backed file inside the handler, before the wrapper cleans it up.
      const handler = jest.fn(async (ctx: any) => {
        const file = ctx.formData.files['file']
        captured = { size: file.size, contents: (await readUploadedFile(file)).toString(), filepath: file.filepath }
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

    it('should remove the temporary file after its write stream closes', async () => {
      await parse(context)
      await expect(access(captured!.filepath)).rejects.toMatchObject({ code: 'ENOENT' })
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
          headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? form.getHeaders()['content-type'] : null)
          },
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
    let resume: jest.SpyInstance
    let onTelemetry: jest.Mock

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      onTelemetry = jest.fn()
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100, onTelemetry, route: 'test' })
      const form = new FormData()
      form.append('file', Buffer.alloc(10), { filename: 'small.bin' })
      context = createMultipartContext(form, { contentLength: String(11 * 1024 * 1024) })
      resume = jest.spyOn(context.request.body, 'resume')
    })

    it('should reject the request before reading the body', async () => {
      await expect(parse(context)).rejects.toThrow('The multipart request is too large.')
    })

    it('should not invoke the handler', async () => {
      await parse(context).catch(() => undefined)
      expect(handler).not.toHaveBeenCalled()
    })

    it('should drain the rejected request body', async () => {
      await parse(context).catch(() => undefined)
      expect(resume).toHaveBeenCalled()
    })

    it('should report a wire-size rejection', async () => {
      await parse(context).catch(() => undefined)
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'wire_size' }))
    })
  })

  describe('when an early-rejected request body stalls while draining', () => {
    let parse: (ctx: any) => Promise<any>
    let context: any
    let destroy: jest.SpyInstance

    beforeEach(async () => {
      jest.useFakeTimers()
      const contentType = new FormData().getHeaders()['content-type']
      const stalledBody = new Readable({ read() {} })
      destroy = jest.spyOn(stalledBody, 'destroy')
      parse = multipartParserWrapper(jest.fn(), { maxSizeInBytes: 100, uploadTimeoutMs: 10 })
      context = {
        request: {
          headers: {
            get: (name: string) => {
              if (name.toLowerCase() === 'content-type') return contentType
              if (name.toLowerCase() === 'content-length') return String(11 * 1024 * 1024)
              return null
            }
          },
          body: stalledBody
        }
      }

      await parse(context).catch(() => undefined)
      jest.advanceTimersByTime(10)
    })

    afterEach(() => {
      context.request.body.destroy()
      jest.useRealTimers()
      jest.clearAllMocks()
    })

    it('should destroy the drain after the configured timeout', () => {
      expect(destroy).toHaveBeenCalled()
    })
  })

  describe('when the rejected-body drain limit is reached', () => {
    let destroyCallsAtLimit: { first: number; second: number }
    let thirdDestroy: jest.SpyInstance

    beforeEach(async () => {
      jest.useFakeTimers()
      const contentType = new FormData().getHeaders()['content-type']
      const inFlightUploadBudget = createInFlightUploadBudget(100, 1)
      const parse: (ctx: any) => Promise<any> = multipartParserWrapper(jest.fn(), {
        inFlightUploadBudget,
        maxSizeInBytes: 100,
        maxWireSizeInBytes: 100,
        uploadTimeoutMs: 100
      })
      const firstBody = new Readable({ read() {} })
      const secondBody = new Readable({ read() {} })
      const firstDestroy = jest.spyOn(firstBody, 'destroy')
      const secondDestroy = jest.spyOn(secondBody, 'destroy')
      const createContext = (body: Readable): any => ({
        request: {
          headers: {
            get: (name: string) => {
              if (name.toLowerCase() === 'content-type') return contentType
              if (name.toLowerCase() === 'content-length') return '101'
              return null
            }
          },
          body
        }
      })

      await parse(createContext(firstBody)).catch(() => undefined)
      await parse(createContext(secondBody)).catch(() => undefined)
      destroyCallsAtLimit = { first: firstDestroy.mock.calls.length, second: secondDestroy.mock.calls.length }

      jest.advanceTimersByTime(100)
      const thirdBody = new Readable({ read() {} })
      thirdDestroy = jest.spyOn(thirdBody, 'destroy')
      await parse(createContext(thirdBody)).catch(() => undefined)
    })

    afterEach(() => {
      jest.runOnlyPendingTimers()
      jest.useRealTimers()
      jest.clearAllMocks()
    })

    it('should destroy only the rejected body that cannot acquire a drain slot', () => {
      expect(destroyCallsAtLimit).toEqual({ first: 0, second: 1 })
    })

    it('should release the drain slot after its timeout', () => {
      expect(thirdDestroy).not.toHaveBeenCalled()
    })
  })

  describe('when multipart framing makes Content-Length larger than the payload limit', () => {
    let response: any
    let stateAfterCompletion: InFlightUploadBudgetSnapshot
    let releaseExistingUpload: () => void

    beforeEach(async () => {
      const form = new FormData()
      form.append('file', Buffer.alloc(9), { filename: 'file.bin' })
      const contentLength = form.getLengthSync()
      const inFlightUploadBudget = createInFlightUploadBudget(10)
      releaseExistingUpload = inFlightUploadBudget.acquire(1).lease!.release
      const parse = multipartParserWrapper(
        jest.fn(async () => ({ status: 200 })),
        {
          inFlightUploadBudget,
          maxSizeInBytes: 10,
          maxWireSizeInBytes: contentLength
        }
      )

      response = await parse(createMultipartContext(form, { contentLength: String(contentLength) }))
      stateAfterCompletion = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      releaseExistingUpload()
      jest.clearAllMocks()
    })

    it('should accept the payload within its logical size limit', () => {
      expect(response.status).toBe(200)
    })

    it('should release the upload while preserving the existing reservation', () => {
      expect(stateAfterCompletion).toMatchObject({ reservedBytes: 1, activeUploads: 1 })
    })
  })

  describe('when a chunked multipart wire body exceeds its wire-size limit', () => {
    let parse: (ctx: any) => Promise<any>
    let context: any
    let onTelemetry: jest.Mock

    beforeEach(() => {
      const form = new FormData()
      form.append('file', Buffer.alloc(1), { filename: 'file.bin' })
      onTelemetry = jest.fn()
      parse = multipartParserWrapper(jest.fn(), {
        maxSizeInBytes: 100,
        maxWireSizeInBytes: 100,
        onTelemetry,
        route: 'test'
      })
      context = createMultipartContext(form)
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should reject the request based on its complete wire size', async () => {
      await expect(parse(context)).rejects.toThrow('The multipart request is too large.')
    })

    it('should report a wire-size rejection', async () => {
      await parse(context).catch(() => undefined)
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'wire_size' }))
    })
  })

  describe('when a request exceeds its wire-size limit and then stalls', () => {
    let error: Error | undefined
    let body: Readable

    beforeEach(async () => {
      const contentType = new FormData().getHeaders()['content-type']
      let sent = false
      body = new Readable({
        read() {
          if (!sent) {
            sent = true
            this.push(Buffer.alloc(101))
          }
        }
      })
      const parse: (ctx: any) => Promise<any> = multipartParserWrapper(jest.fn(), {
        inFlightUploadBudget: createInFlightUploadBudget(100),
        maxSizeInBytes: 100,
        maxWireSizeInBytes: 100,
        uploadTimeoutMs: 25
      })
      const context: any = {
        request: {
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
          body
        }
      }

      error = await parse(context).then(
        () => undefined,
        (reason: Error) => reason
      )
    })

    afterEach(() => {
      body.destroy()
      jest.clearAllMocks()
    })

    it('should reject immediately with the wire-size error instead of timing out', () => {
      expect(error?.message).toBe('The multipart request is too large.')
    })
  })

  describe('when a stalled request exceeds the available aggregate capacity', () => {
    let response: any
    let body: Readable
    let onTelemetry: jest.Mock
    let stateAfterRejection: InFlightUploadBudgetSnapshot
    let releaseExistingUpload: () => void

    beforeEach(async () => {
      const inFlightUploadBudget = createInFlightUploadBudget(100)
      releaseExistingUpload = inFlightUploadBudget.acquire(90).lease!.release
      onTelemetry = jest.fn()
      const stalledUpload = createStalledFileBody(20)
      body = stalledUpload.body
      const parse: (ctx: any) => Promise<any> = multipartParserWrapper(jest.fn(), {
        inFlightUploadBudget,
        maxSizeInBytes: 100,
        maxWireSizeInBytes: 1000,
        uploadTimeoutMs: 1000,
        onTelemetry,
        route: 'test'
      })

      response = await parse({
        request: {
          headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? stalledUpload.contentType : null)
          },
          body
        }
      })
      stateAfterRejection = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      body.destroy()
      releaseExistingUpload()
      jest.clearAllMocks()
    })

    it('should respond with the capacity error without waiting for the timeout', () => {
      expect(response.status).toBe(503)
    })

    it('should report a byte-capacity rejection', () => {
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'bytes' }))
    })

    it('should release its slot while preserving the existing reservation', () => {
      expect(stateAfterRejection).toMatchObject({ reservedBytes: 90, activeUploads: 1 })
    })
  })

  describe('when a stalled request exceeds the per-request payload limit', () => {
    let error: Error | undefined
    let body: Readable
    let onTelemetry: jest.Mock
    let stateAfterRejection: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      const inFlightUploadBudget = createInFlightUploadBudget(100)
      onTelemetry = jest.fn()
      const stalledUpload = createStalledFileBody(20)
      body = stalledUpload.body
      const parse: (ctx: any) => Promise<any> = multipartParserWrapper(jest.fn(), {
        inFlightUploadBudget,
        maxSizeInBytes: 10,
        maxWireSizeInBytes: 1000,
        uploadTimeoutMs: 1000,
        onTelemetry,
        route: 'test'
      })

      error = await parse({
        request: {
          headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? stalledUpload.contentType : null)
          },
          body
        }
      }).then(
        () => undefined,
        (reason: Error) => reason
      )
      stateAfterRejection = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      body.destroy()
      jest.clearAllMocks()
    })

    it('should preserve the payload-size error instead of reporting a timeout', () => {
      expect(error?.message).toBe('An uploaded file exceeds the maximum allowed size.')
    })

    it('should report a payload-size rejection', () => {
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'payload_size' }))
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterRejection).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
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

  describe('when the Content-Length header is malformed', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any
    let onTelemetry: jest.Mock

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      onTelemetry = jest.fn()
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100, onTelemetry, route: 'test' })
      const form = new FormData()
      form.append('file', Buffer.alloc(10), { filename: 'small.bin' })
      context = createMultipartContext(form, { contentLength: '-1' })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should reject the request with a clear error', async () => {
      await expect(parse(context)).rejects.toThrow('Invalid Content-Length header.')
    })

    it('should report an invalid-multipart rejection', async () => {
      await parse(context).catch(() => undefined)
      expect(onTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rejected', reason: 'invalid_multipart' })
      )
    })
  })

  describe('when the per-request byte limit is invalid', () => {
    let createParser: () => unknown

    beforeEach(() => {
      createParser = () => multipartParserWrapper(jest.fn(), { maxSizeInBytes: 0 })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should reject the parser configuration', () => {
      expect(createParser).toThrow('maxSizeInBytes must be a positive safe integer')
    })
  })

  describe('when the in-flight byte limit is invalid', () => {
    let createParser: () => unknown

    beforeEach(() => {
      createParser = () => createInFlightUploadBudget(Infinity)
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should reject the parser configuration', () => {
      expect(createParser).toThrow('maxInFlightUploadBytes must be a positive safe integer')
    })
  })

  describe('when the default concurrent upload limit is used', () => {
    let maxConcurrentUploads: number

    beforeEach(() => {
      maxConcurrentUploads = createInFlightUploadBudget().snapshot().maxConcurrentUploads
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should align with the deployed limit of forty uploads', () => {
      expect(maxConcurrentUploads).toBe(40)
    })
  })

  describe('when the upload-state observer throws', () => {
    let stateAfterAcquire: InFlightUploadBudgetSnapshot
    let stateAfterRelease: InFlightUploadBudgetSnapshot

    beforeEach(() => {
      const budget = createInFlightUploadBudget(100, 40, () => {
        throw new Error('metrics unavailable')
      })
      const acquisition = budget.acquire(25)
      stateAfterAcquire = budget.snapshot()
      acquisition.lease!.release()
      stateAfterRelease = budget.snapshot()
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should preserve the acquired reservation', () => {
      expect(stateAfterAcquire).toMatchObject({ reservedBytes: 25, activeUploads: 1 })
    })

    it('should still release the reservation', () => {
      expect(stateAfterRelease).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when the upload telemetry observer throws', () => {
    let response: any
    let stateAfterCompletion: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      const inFlightUploadBudget = createInFlightUploadBudget(100000)
      const parse = multipartParserWrapper(
        jest.fn(async () => ({ status: 200 })),
        {
          maxSizeInBytes: 100000,
          inFlightUploadBudget,
          onTelemetry: () => {
            throw new Error('metrics unavailable')
          }
        }
      )
      const form = new FormData()
      form.append('file', Buffer.from('hello world'), { filename: 'ok.bin' })

      response = await parse(createMultipartContext(form))
      stateAfterCompletion = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should preserve the handler response', () => {
      expect(response.status).toBe(200)
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterCompletion).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when the rejection telemetry observer throws', () => {
    let response: any
    let releaseExistingUpload: () => void

    beforeEach(async () => {
      const inFlightUploadBudget = createInFlightUploadBudget(100, 1)
      releaseExistingUpload = inFlightUploadBudget.acquire(0).lease!.release
      const parse = multipartParserWrapper(jest.fn(), {
        maxSizeInBytes: 100,
        inFlightUploadBudget,
        onTelemetry: () => {
          throw new Error('metrics unavailable')
        }
      })
      const form = new FormData()
      form.append('file', Buffer.from('hello world'), { filename: 'ok.bin' })

      response = await parse(createMultipartContext(form))
    })

    afterEach(() => {
      releaseExistingUpload()
      jest.clearAllMocks()
    })

    it('should preserve the concurrency response', () => {
      expect(response.status).toBe(503)
    })
  })

  describe('when an initial reservation is not a non-negative safe integer', () => {
    let errors: string[]
    let stateAfterAttempts: InFlightUploadBudgetSnapshot

    beforeEach(() => {
      const budget = createInFlightUploadBudget(100)
      errors = [-1, 0.5, NaN, Infinity].map((value) => {
        try {
          budget.acquire(value)
          return 'did not throw'
        } catch (error: any) {
          return error.message
        }
      })
      stateAfterAttempts = budget.snapshot()
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should reject every invalid reservation without changing limiter state', () => {
      expect({ errors, state: stateAfterAttempts }).toEqual({
        errors: [
          'upload reservation must be a non-negative safe integer, got -1',
          'upload reservation must be a non-negative safe integer, got 0.5',
          'upload reservation must be a non-negative safe integer, got NaN',
          'upload reservation must be a non-negative safe integer, got Infinity'
        ],
        state: expect.objectContaining({ reservedBytes: 0, activeUploads: 0 })
      })
    })
  })

  describe('when a resized reservation is not a non-negative safe integer', () => {
    let errors: string[]
    let stateAfterAttempts: InFlightUploadBudgetSnapshot

    beforeEach(() => {
      const budget = createInFlightUploadBudget(100)
      const lease = budget.acquire(0).lease!
      errors = [-1, 0.5, NaN, Infinity].map((value) => {
        try {
          lease.resize(value)
          return 'did not throw'
        } catch (error: any) {
          return error.message
        }
      })
      lease.release()
      stateAfterAttempts = budget.snapshot()
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should reject every invalid resize without corrupting limiter state', () => {
      expect({ errors, state: stateAfterAttempts }).toEqual({
        errors: [
          'upload reservation must be a non-negative safe integer, got -1',
          'upload reservation must be a non-negative safe integer, got 0.5',
          'upload reservation must be a non-negative safe integer, got NaN',
          'upload reservation must be a non-negative safe integer, got Infinity'
        ],
        state: expect.objectContaining({ reservedBytes: 0, activeUploads: 0 })
      })
    })
  })

  describe('when the in-flight byte limit is smaller than the per-request limit', () => {
    let createParser: () => unknown

    beforeEach(() => {
      createParser = () =>
        multipartParserWrapper(jest.fn(), {
          maxSizeInBytes: 101,
          inFlightUploadBudget: createInFlightUploadBudget(100)
        })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should reject the parser configuration', () => {
      expect(createParser).toThrow('maxInFlightUploadBytes (100) must be greater than or equal to maxSizeInBytes (101)')
    })
  })

  describe('when the wire-size limit is smaller than the payload limit', () => {
    let createParser: () => unknown

    beforeEach(() => {
      createParser = () => multipartParserWrapper(jest.fn(), { maxSizeInBytes: 101, maxWireSizeInBytes: 100 })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should reject the parser configuration', () => {
      expect(createParser).toThrow('maxWireSizeInBytes (100) must be greater than or equal to maxSizeInBytes (101)')
    })
  })

  describe('when an upload with Content-Length completes', () => {
    let stateAfterCompletion: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      const handler = jest.fn(async () => ({ status: 200 }))
      const inFlightUploadBudget = createInFlightUploadBudget(100)
      const parse = multipartParserWrapper(handler, { inFlightUploadBudget, maxSizeInBytes: 100 })
      const form = new FormData()
      form.append('file', Buffer.alloc(10), { filename: 'file.bin' })

      await parse(createMultipartContext(form, { contentLength: '60' }))
      stateAfterCompletion = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterCompletion).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when an admitted upload fails', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let secondResponse: any
    let inFlightUploadBudget: InFlightUploadBudget
    let stateAfterFailure: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      handler = jest.fn().mockRejectedValueOnce(new Error('handler failed')).mockResolvedValueOnce({ status: 200 })
      inFlightUploadBudget = createInFlightUploadBudget(100)
      parse = multipartParserWrapper(handler, {
        inFlightUploadBudget,
        maxSizeInBytes: 100
      })

      const firstForm = new FormData()
      firstForm.append('file', Buffer.alloc(10), { filename: 'a.bin' })
      const secondForm = new FormData()
      secondForm.append('file', Buffer.alloc(10), { filename: 'b.bin' })

      await parse(createMultipartContext(firstForm)).catch(() => undefined)
      stateAfterFailure = inFlightUploadBudget.snapshot()
      secondResponse = await parse(createMultipartContext(secondForm))
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should release the reservation for the next upload', () => {
      expect(secondResponse.status).toBe(200)
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterFailure).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when the concurrent upload limit is reached', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let releaseFirstUpload: () => void
    let firstUploadInHandler: Promise<void>
    let firstUpload: Promise<any>
    let secondResponse: any
    let onTelemetry: jest.Mock

    beforeEach(async () => {
      let signalFirstInHandler: () => void
      firstUploadInHandler = new Promise<void>((resolve) => {
        signalFirstInHandler = resolve
      })
      const gate = new Promise<void>((resolve) => {
        releaseFirstUpload = resolve
      })
      handler = jest
        .fn()
        .mockImplementationOnce(async () => {
          signalFirstInHandler()
          await gate
          return { status: 200 }
        })
        .mockResolvedValue({ status: 200 })
      onTelemetry = jest.fn()
      parse = multipartParserWrapper(handler, {
        inFlightUploadBudget: createInFlightUploadBudget(100, 1),
        maxSizeInBytes: 100,
        onTelemetry,
        route: 'test'
      })

      const firstForm = new FormData()
      firstForm.append('file', Buffer.alloc(10), { filename: 'a.bin' })
      const secondForm = new FormData()
      secondForm.append('file', Buffer.alloc(10), { filename: 'b.bin' })

      firstUpload = parse(createMultipartContext(firstForm))
      await firstUploadInHandler
      secondResponse = await parse(createMultipartContext(secondForm))
    })

    afterEach(async () => {
      releaseFirstUpload()
      await firstUpload
      jest.clearAllMocks()
    })

    it('should shed the additional upload with a 503 response', () => {
      expect(secondResponse.status).toBe(503)
    })

    it('should explain that the concurrent upload limit was reached', () => {
      expect(secondResponse.body.message).toBe('Server is handling too many concurrent uploads, please retry shortly.')
    })

    it('should report a concurrency rejection', () => {
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'concurrency' }))
    })
  })

  describe('when an upload understates its Content-Length and exceeds available capacity', () => {
    let response: any
    let onTelemetry: jest.Mock
    let stateAfterRejection: InFlightUploadBudgetSnapshot
    let releaseExistingUpload: () => void

    beforeEach(async () => {
      const inFlightUploadBudget = createInFlightUploadBudget(100)
      const existingLease = inFlightUploadBudget.acquire(90).lease!
      releaseExistingUpload = existingLease.release
      onTelemetry = jest.fn()
      const parse = multipartParserWrapper(jest.fn(), {
        inFlightUploadBudget,
        maxSizeInBytes: 100,
        onTelemetry,
        route: 'test'
      })
      const form = new FormData()
      form.append('file', Buffer.alloc(20), { filename: 'file.bin' })

      response = await parse(createMultipartContext(form, { contentLength: '5' }))
      stateAfterRejection = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      releaseExistingUpload()
      jest.clearAllMocks()
    })

    it('should reject the upload with a 503', () => {
      expect(response.status).toBe(503)
    })

    it('should report the actual attempted payload bytes', () => {
      expect(onTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rejected', reason: 'bytes', actualBytes: 20 })
      )
    })

    it('should release the rejected upload while preserving the existing reservation', () => {
      expect(stateAfterRejection).toMatchObject({ reservedBytes: 90, activeUploads: 1 })
    })
  })

  describe('when receiving the multipart body times out', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any
    let response: any
    let onTelemetry: jest.Mock
    let stateAfterTimeout: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      handler = jest.fn(async () => ({ status: 200 }))
      onTelemetry = jest.fn()
      const inFlightUploadBudget = createInFlightUploadBudget(100, 1)
      parse = multipartParserWrapper(handler, {
        maxSizeInBytes: 100,
        inFlightUploadBudget,
        onTelemetry,
        route: 'test',
        uploadTimeoutMs: 10
      })
      const contentType = new FormData().getHeaders()['content-type']
      const stalledBody = new Readable({
        read() {}
      })
      context = {
        request: {
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
          body: stalledBody
        }
      }

      response = await parse(context)
      stateAfterTimeout = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should respond with a 408', () => {
      expect(response.status).toBe(408)
    })

    it('should report a timeout rejection', () => {
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'timeout' }))
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterTimeout).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when the request body stream errors mid-upload', () => {
    let handler: jest.Mock
    let parse: (ctx: any) => Promise<any>
    let context: any
    let inFlightUploadBudget: InFlightUploadBudget

    beforeEach(() => {
      handler = jest.fn(async () => ({ status: 200 }))
      inFlightUploadBudget = createInFlightUploadBudget(100000)
      parse = multipartParserWrapper(handler, { maxSizeInBytes: 100000, inFlightUploadBudget })
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

    it('should release all reserved bytes and the upload slot', async () => {
      await parse(context).catch(() => undefined)
      expect(inFlightUploadBudget.snapshot()).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when the temporary upload directory cannot be removed', () => {
    let cleanupDirectory: string
    let inFlightUploadBudget: InFlightUploadBudget
    let onCleanupError: jest.Mock
    let stateAfterCleanupFailure: InFlightUploadBudgetSnapshot
    let acquisitionAfterCleanupFailure: ReturnType<InFlightUploadBudget['acquire']>
    let removeDirectory: jest.Mock

    beforeEach(async () => {
      inFlightUploadBudget = createInFlightUploadBudget(100)
      onCleanupError = jest.fn()
      removeDirectory = jest.fn().mockRejectedValueOnce(new Error('cleanup failed'))
      const handler = jest.fn(async (ctx: any) => {
        cleanupDirectory = dirname(ctx.formData.files.file.filepath)
        return { status: 200 }
      })
      const parse = multipartParserWrapper(handler, {
        inFlightUploadBudget,
        maxSizeInBytes: 100,
        onCleanupError,
        route: 'test',
        fileSystem: { createWriteStream: createNodeWriteStream, mkdtemp: fsPromises.mkdtemp, rm: removeDirectory },
        cleanupRetryDelaysMs: []
      })
      const form = new FormData()
      form.append('metadata', 'memory-only field bytes')
      form.append('file', Buffer.from('orphaned bytes'), { filename: 'file.bin' })

      await parse(createMultipartContext(form))
      stateAfterCleanupFailure = inFlightUploadBudget.snapshot()
      acquisitionAfterCleanupFailure = inFlightUploadBudget.acquire(87)
    })

    afterEach(async () => {
      await fsPromises.rm(cleanupDirectory, { recursive: true, force: true })
      jest.clearAllMocks()
    })

    it('should release the upload slot while retaining the orphaned byte reservation', () => {
      expect({
        state: stateAfterCleanupFailure,
        rejectionReason: acquisitionAfterCleanupFailure.rejectionReason
      }).toEqual({
        state: expect.objectContaining({
          reservedBytes: Buffer.byteLength('orphaned bytes'),
          orphanedBytes: Buffer.byteLength('orphaned bytes'),
          reservedFiles: 1,
          orphanedFiles: 1,
          orphanedDirectories: 1,
          activeUploads: 0
        }),
        rejectionReason: 'bytes'
      })
    })

    it('should report the cleanup failure', () => {
      expect(onCleanupError).toHaveBeenCalledWith({
        route: 'test',
        error: expect.objectContaining({ message: 'cleanup failed' }),
        attempt: 0,
        willRetry: false
      })
    })
  })

  describe('when retrying temporary upload cleanup succeeds', () => {
    let cleanupDirectory: string
    let stateBeforeRetry: InFlightUploadBudgetSnapshot
    let stateAfterRetry: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      let signalRetryCompleted: () => void
      const retryCompleted = new Promise<void>((resolve) => {
        signalRetryCompleted = resolve
      })
      const removeDirectory = jest
        .fn()
        .mockRejectedValueOnce(new Error('transient cleanup failure'))
        .mockImplementationOnce(async (path: string, options: Parameters<typeof fsPromises.rm>[1]) => {
          await fsPromises.rm(path, options)
          signalRetryCompleted()
        })
      const inFlightUploadBudget = createInFlightUploadBudget(100)
      const handler = jest.fn(async (ctx: any) => {
        cleanupDirectory = dirname(ctx.formData.files.file.filepath)
        return { status: 200 }
      })
      const parse = multipartParserWrapper(handler, {
        inFlightUploadBudget,
        maxSizeInBytes: 100,
        fileSystem: { createWriteStream: createNodeWriteStream, mkdtemp: fsPromises.mkdtemp, rm: removeDirectory },
        cleanupRetryDelaysMs: [0]
      })
      const form = new FormData()
      form.append('file', Buffer.from('retry bytes'), { filename: 'file.bin' })

      await parse(createMultipartContext(form))
      stateBeforeRetry = inFlightUploadBudget.snapshot()
      await retryCompleted
      await new Promise<void>((resolve) => setImmediate(resolve))
      stateAfterRetry = inFlightUploadBudget.snapshot()
    })

    afterEach(async () => {
      await fsPromises.rm(cleanupDirectory, { recursive: true, force: true })
      jest.clearAllMocks()
    })

    it('should retain capacity until cleanup succeeds and then release the orphaned bytes', () => {
      expect({ before: stateBeforeRetry, after: stateAfterRetry }).toEqual({
        before: expect.objectContaining({
          reservedBytes: Buffer.byteLength('retry bytes'),
          orphanedBytes: Buffer.byteLength('retry bytes'),
          reservedFiles: 1,
          orphanedFiles: 1,
          orphanedDirectories: 1,
          activeUploads: 0
        }),
        after: expect.objectContaining({
          reservedBytes: 0,
          orphanedBytes: 0,
          reservedFiles: 0,
          orphanedFiles: 0,
          orphanedDirectories: 0,
          activeUploads: 0
        })
      })
    })
  })

  describe('when cleanup leaves a zero-byte temporary file behind', () => {
    let cleanupDirectory: string
    let stateAfterCleanupFailure: InFlightUploadBudgetSnapshot
    let subsequentAcquisition: ReturnType<InFlightUploadBudget['acquire']>

    beforeEach(async () => {
      const removeDirectory = jest.fn().mockRejectedValueOnce(new Error('cleanup failed'))
      const inFlightUploadBudget = createInFlightUploadBudget(100, 40, undefined, 10, 1)
      const handler = jest.fn(async (ctx: any) => {
        cleanupDirectory = dirname(ctx.formData.files.file.filepath)
        return { status: 200 }
      })
      const parse = multipartParserWrapper(handler, {
        inFlightUploadBudget,
        maxSizeInBytes: 100,
        fileSystem: { createWriteStream: createNodeWriteStream, mkdtemp: fsPromises.mkdtemp, rm: removeDirectory },
        cleanupRetryDelaysMs: []
      })
      const form = new FormData()
      form.append('file', Buffer.alloc(0), { filename: 'empty.bin' })

      await parse(createMultipartContext(form))
      stateAfterCleanupFailure = inFlightUploadBudget.snapshot()
      subsequentAcquisition = inFlightUploadBudget.acquire(0)
    })

    afterEach(async () => {
      await fsPromises.rm(cleanupDirectory, { recursive: true, force: true })
      jest.clearAllMocks()
    })

    it('should retain the file and directory resources even though no payload bytes remain', () => {
      expect(stateAfterCleanupFailure).toMatchObject({
        reservedBytes: 0,
        orphanedBytes: 0,
        reservedFiles: 1,
        orphanedFiles: 1,
        orphanedDirectories: 1,
        activeUploads: 0
      })
    })

    it('should stop admitting uploads after the orphan-directory safety limit is reached', () => {
      expect(subsequentAcquisition.rejectionReason).toBe('storage')
    })
  })

  describe('when an upload exceeds the shared temporary-file budget', () => {
    let response: any
    let stateAfterRejection: InFlightUploadBudgetSnapshot
    let onTelemetry: jest.Mock

    beforeEach(async () => {
      const inFlightUploadBudget = createInFlightUploadBudget(100, 40, undefined, 1)
      onTelemetry = jest.fn()
      const parse = multipartParserWrapper(
        jest.fn(async () => ({ status: 200 })),
        {
          inFlightUploadBudget,
          maxSizeInBytes: 100,
          onTelemetry,
          route: 'test'
        }
      )
      const form = new FormData()
      form.append('first', Buffer.alloc(0), { filename: 'first.bin' })
      form.append('second', Buffer.alloc(0), { filename: 'second.bin' })

      response = await parse(createMultipartContext(form))
      stateAfterRejection = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should respond with a retryable storage-capacity error', () => {
      expect(response).toMatchObject({
        status: 503,
        body: { message: 'Server is buffering too many upload files, please retry shortly.' }
      })
    })

    it('should release the temporary-file reservation after removing the upload directory', () => {
      expect(stateAfterRejection).toMatchObject({ reservedFiles: 0, activeUploads: 0 })
    })

    it('should report a temporary-file-capacity rejection', () => {
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'files' }))
    })
  })

  describe('when an upload stalls after exceeding the shared temporary-file budget', () => {
    let response: any
    let body: Readable
    let stateAfterRejection: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      const boundary = '----StalledFileBudgetBoundary'
      let sent = false
      body = new Readable({
        read() {
          if (!sent) {
            sent = true
            this.push(
              Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="first"; filename="first.bin"\r\n\r\n` +
                  `\r\n--${boundary}\r\nContent-Disposition: form-data; name="second"; filename="second.bin"\r\n\r\nx`
              )
            )
          }
        }
      })
      const inFlightUploadBudget = createInFlightUploadBudget(100, 40, undefined, 1)
      const parse = multipartParserWrapper(jest.fn(), {
        inFlightUploadBudget,
        maxSizeInBytes: 100,
        uploadTimeoutMs: 25
      })

      const context: any = {
        request: {
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : null
          },
          body
        }
      }
      response = await parse(context)
      stateAfterRejection = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      body.destroy()
      jest.clearAllMocks()
    })

    it('should tear down the stalled body while preserving the file-capacity response', () => {
      expect(response).toMatchObject({
        status: 503,
        body: { message: 'Server is buffering too many upload files, please retry shortly.' }
      })
    })

    it('should release the upload slot and temporary-file reservation', () => {
      expect(stateAfterRejection).toMatchObject({ reservedFiles: 0, activeUploads: 0 })
    })
  })

  describe('when writing an uploaded file to temporary storage fails', () => {
    let response: any
    let handler: jest.Mock
    let onTelemetry: jest.Mock
    let createWriteStream: jest.Mock
    let stateAfterFailure: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      const storageError = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      const failedWriteStream = new Writable({
        write(_chunk, _encoding, callback): void {
          callback(storageError)
        }
      })
      createWriteStream = jest.fn().mockReturnValue(failedWriteStream as any)
      const inFlightUploadBudget = createInFlightUploadBudget(100)
      handler = jest.fn(async () => ({ status: 200 }))
      onTelemetry = jest.fn()
      const parse = multipartParserWrapper(handler, {
        inFlightUploadBudget,
        maxSizeInBytes: 100,
        onTelemetry,
        route: 'test',
        fileSystem: { createWriteStream, mkdtemp: fsPromises.mkdtemp, rm: fsPromises.rm }
      })
      const form = new FormData()
      form.append('file', Buffer.from('contents'), { filename: 'file.bin' })

      response = await parse(createMultipartContext(form))
      stateAfterFailure = inFlightUploadBudget.snapshot()
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should respond with a retryable service-unavailable error', () => {
      expect(response).toMatchObject({
        status: 503,
        headers: { 'Retry-After': '5' },
        body: { message: 'The server could not store the multipart upload, please retry shortly.' }
      })
    })

    it('should report a server-storage rejection', () => {
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'storage' }))
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterFailure).toMatchObject({ reservedBytes: 0, orphanedBytes: 0, activeUploads: 0 })
    })

    it('should not invoke the deployment handler', () => {
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('when concurrent uploads on separate wrappers would exceed their shared byte budget', () => {
    let handler: jest.Mock
    let firstParser: (ctx: any) => Promise<any>
    let secondParser: (ctx: any) => Promise<any>
    let releaseFirstUpload: () => void
    let firstUploadInHandler: Promise<void>
    let firstUpload: Promise<any>
    let secondContext: any

    beforeEach(async () => {
      let signalFirstInHandler: () => void
      firstUploadInHandler = new Promise<void>((resolve) => {
        signalFirstInHandler = resolve
      })
      const gate = new Promise<void>((resolve) => {
        releaseFirstUpload = resolve
      })

      handler = jest
        .fn()
        .mockImplementationOnce(async () => {
          signalFirstInHandler()
          await gate
          return { status: 200 }
        })
        .mockResolvedValue({ status: 200 })
      // Unknown-length requests grow their reservation as file bytes arrive. The first upload
      // leaves less capacity than the second upload needs.
      const inFlightUploadBudget = createInFlightUploadBudget(101)
      firstParser = multipartParserWrapper(handler, { inFlightUploadBudget, maxSizeInBytes: 101 })
      secondParser = multipartParserWrapper(handler, { inFlightUploadBudget, maxSizeInBytes: 101 })

      const firstForm = new FormData()
      firstForm.append('file', Buffer.alloc(100), { filename: 'a.bin' })
      const secondForm = new FormData()
      secondForm.append('file', Buffer.alloc(10), { filename: 'b.bin' })
      secondContext = createMultipartContext(secondForm)

      // Hold the single slot busy inside the handler until we release it.
      firstUpload = firstParser(createMultipartContext(firstForm))
      await firstUploadInHandler
    })

    afterEach(async () => {
      releaseFirstUpload()
      await firstUpload
      jest.clearAllMocks()
    })

    it('should shed the extra upload with a 503 response', async () => {
      const response = await secondParser(secondContext)

      expect(response.status).toBe(503)
    })

    it('should not invoke the handler for the shed upload', async () => {
      await secondParser(secondContext)

      // Only the first (still-pending) upload reached the handler.
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })
})

describe('toDeploymentFile', () => {
  describe('when the same temp-backed file is hashed repeatedly', () => {
    let expectedHash: string
    let hashes: string[]
    let samePromise: boolean
    let tempDirectory: string

    beforeEach(async () => {
      const content = Buffer.from('memoized hash content')
      tempDirectory = await fsPromises.mkdtemp(join(tmpdir(), 'deployment-file-test-'))
      const filepath = join(tempDirectory, 'content.bin')
      await fsPromises.writeFile(filepath, content)
      const uploadedFile: UploadedFile = {
        encoding: '7bit',
        fieldname: 'file',
        filename: 'content.bin',
        filepath,
        mimeType: 'application/octet-stream',
        size: content.length
      }
      const deploymentFile = toDeploymentFile(uploadedFile)
      const firstHash = deploymentFile.getHash()
      const secondHash = deploymentFile.getHash()

      samePromise = firstHash === secondHash
      hashes = await Promise.all([firstHash, secondHash])
      expectedHash = await hashV1(content)
    })

    afterEach(async () => {
      await fsPromises.rm(tempDirectory, { force: true, recursive: true })
      jest.resetAllMocks()
    })

    it('should reuse one hash calculation and return the same CID', () => {
      expect({ hashes, samePromise }).toEqual({ hashes: [expectedHash, expectedHash], samePromise: true })
    })
  })

  describe('when the file was buffered before its hash is requested', () => {
    let actualHash: string
    let expectedHash: string
    let tempDirectory: string

    beforeEach(async () => {
      const content = Buffer.from('buffered hash content')
      tempDirectory = await fsPromises.mkdtemp(join(tmpdir(), 'deployment-file-test-'))
      const filepath = join(tempDirectory, 'content.bin')
      await fsPromises.writeFile(filepath, content)
      const uploadedFile: UploadedFile = {
        encoding: '7bit',
        fieldname: 'file',
        filename: 'content.bin',
        filepath,
        mimeType: 'application/octet-stream',
        size: content.length
      }
      const deploymentFile = toDeploymentFile(uploadedFile)

      await deploymentFile.asBuffer()
      await fsPromises.rm(filepath)
      actualHash = await deploymentFile.getHash()
      expectedHash = await hashV1(content)
    })

    afterEach(async () => {
      await fsPromises.rm(tempDirectory, { force: true, recursive: true })
      jest.resetAllMocks()
    })

    it('should calculate the CID from the memoized buffer without reopening the file', () => {
      expect(actualHash).toBe(expectedHash)
    })
  })
})
