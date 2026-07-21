import { Router } from '@dcl/http-server'
import { createServerComponent } from '@dcl/http-server'
import { defaultServerConfig } from '@dcl/test-helpers'
import { createRecordConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { errorHandler } from '@dcl/http-commons'
import { ClientRequest, request } from 'http'
import {
  createInFlightUploadBudget,
  InFlightUploadBudget,
  InFlightUploadBudgetSnapshot,
  multipartParserWrapper,
  MultipartTelemetryEvent
} from '../../src/logic/multipart'

type TestServer = {
  baseUrl: string
  inFlightUploadBudget: InFlightUploadBudget
  stop: () => Promise<void>
}

type PendingUpload = {
  request: ClientRequest
  response: Promise<{ status: number; body: string }>
}

const BOUNDARY = '----MultipartLimiterBoundary'

async function startMultipartServer(options: {
  capacity: number
  maxSizeInBytes?: number
  maxWireSizeInBytes?: number
  maxConcurrentUploads?: number
  timeoutMs?: number
  handler?: () => Promise<{ status: number }>
  onTelemetry?: (event: MultipartTelemetryEvent) => void
}): Promise<TestServer> {
  const serverConfig = { ...defaultServerConfig(), HTTP_SERVER_HOST: '127.0.0.1' }
  const config = createRecordConfigComponent(serverConfig)
  const logs = await createLogComponent({ config })
  const server = await createServerComponent<Record<string, never>>({ config, logs }, { http: {} })
  const router = new Router<Record<string, never>>()
  const inFlightUploadBudget = createInFlightUploadBudget(options.capacity, options.maxConcurrentUploads)
  const handler = options.handler ?? (async () => ({ status: 200 }))

  router.use(errorHandler as any)
  router.post(
    '/upload',
    multipartParserWrapper(handler, {
      inFlightUploadBudget,
      maxSizeInBytes: options.maxSizeInBytes ?? options.capacity,
      maxWireSizeInBytes: options.maxWireSizeInBytes,
      onTelemetry: options.onTelemetry,
      route: 'integration-test',
      uploadTimeoutMs: options.timeoutMs
    })
  )
  server.use(router.middleware())
  server.setContext({})
  await server.start!({ started: () => true, live: () => true, getComponents: () => ({}) })

  return {
    baseUrl: `http://${serverConfig.HTTP_SERVER_HOST}:${serverConfig.HTTP_SERVER_PORT}`,
    inFlightUploadBudget,
    stop: () => server.stop()
  }
}

function openChunkedUpload(baseUrl: string): PendingUpload {
  let settled = false
  let uploadRequest: ClientRequest
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    uploadRequest = request(
      `${baseUrl}/upload`,
      {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }
      },
      (uploadResponse) => {
        const chunks: Buffer[] = []
        uploadResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
        uploadResponse.on('end', () => {
          settled = true
          resolve({ status: uploadResponse.statusCode!, body: Buffer.concat(chunks).toString() })
        })
      }
    )
    uploadRequest.on('error', (error) => {
      if (!settled) {
        reject(error)
      }
    })
    uploadRequest.write(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="file.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
    )
  })

  return { request: uploadRequest!, response }
}

function finishUpload(upload: PendingUpload, bytes: number): void {
  upload.request.write(Buffer.alloc(bytes))
  upload.request.end(`\r\n--${BOUNDARY}--\r\n`)
}

function sendKnownLengthUpload(baseUrl: string, bytes: number): Promise<{ status: number; body: string }> {
  const body = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="file.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ),
    Buffer.alloc(bytes),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`)
  ])

  return new Promise((resolve, reject) => {
    const uploadRequest = request(
      `${baseUrl}/upload`,
      {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          'content-length': body.length
        }
      },
      (uploadResponse) => {
        const chunks: Buffer[] = []
        uploadResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
        uploadResponse.on('end', () => {
          resolve({ status: uploadResponse.statusCode!, body: Buffer.concat(chunks).toString() })
        })
      }
    )
    uploadRequest.on('error', reject)
    uploadRequest.end(body)
  })
}

describe('multipart limiter over HTTP', () => {
  describe('when an upload has a known Content-Length including multipart framing', () => {
    let server: TestServer
    let result: { status: number; body: string }
    let stateAfterUpload: InFlightUploadBudgetSnapshot
    let releaseExistingUpload: () => void

    beforeEach(async () => {
      server = await startMultipartServer({ capacity: 10, maxSizeInBytes: 10 })
      releaseExistingUpload = server.inFlightUploadBudget.acquire(1).lease!.release
      result = await sendKnownLengthUpload(server.baseUrl, 9)
      stateAfterUpload = server.inFlightUploadBudget.snapshot()
    })

    afterEach(async () => {
      releaseExistingUpload()
      await server.stop()
      jest.clearAllMocks()
    })

    it('should accept a payload within the logical payload limit', () => {
      expect(result.status).toBe(200)
    })

    it('should release the upload while preserving the existing reservation', () => {
      expect(stateAfterUpload).toMatchObject({ reservedBytes: 1, activeUploads: 1 })
    })
  })

  describe('when a small chunked upload has no Content-Length', () => {
    let server: TestServer
    let result: { status: number; body: string }
    let stateAfterUpload: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      server = await startMultipartServer({ capacity: 100 })
      const upload = openChunkedUpload(server.baseUrl)
      finishUpload(upload, 10)
      result = await upload.response
      stateAfterUpload = server.inFlightUploadBudget.snapshot()
    })

    afterEach(async () => {
      await server.stop()
      jest.clearAllMocks()
    })

    it('should accept the upload', () => {
      expect(result.status).toBe(200)
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterUpload).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when chunked uploads exceed the shared byte budget', () => {
    let server: TestServer
    let releaseFirstUpload: () => void
    let firstUpload: PendingUpload
    let secondResult: { status: number; body: string }
    let recoveryResult: { status: number; body: string }
    let stateAfterRecovery: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      let signalFirstHandler: () => void
      const firstHandlerReached = new Promise<void>((resolve) => {
        signalFirstHandler = resolve
      })
      const firstHandlerGate = new Promise<void>((resolve) => {
        releaseFirstUpload = resolve
      })
      const handler = jest
        .fn()
        .mockImplementationOnce(async () => {
          signalFirstHandler()
          await firstHandlerGate
          return { status: 200 }
        })
        .mockResolvedValue({ status: 200 })
      server = await startMultipartServer({ capacity: 100, handler })

      firstUpload = openChunkedUpload(server.baseUrl)
      finishUpload(firstUpload, 90)
      await firstHandlerReached

      const secondUpload = openChunkedUpload(server.baseUrl)
      finishUpload(secondUpload, 20)
      secondResult = await secondUpload.response

      releaseFirstUpload()
      await firstUpload.response

      const recoveryUpload = openChunkedUpload(server.baseUrl)
      finishUpload(recoveryUpload, 20)
      recoveryResult = await recoveryUpload.response
      stateAfterRecovery = server.inFlightUploadBudget.snapshot()
    })

    afterEach(async () => {
      releaseFirstUpload()
      firstUpload.request.destroy()
      await server.stop()
      jest.clearAllMocks()
    })

    it('should reject the upload that exceeds available bytes', () => {
      expect(secondResult.status).toBe(503)
    })

    it('should admit a later upload after capacity is released', () => {
      expect(recoveryResult.status).toBe(200)
    })

    it('should release every byte and upload slot after recovery', () => {
      expect(stateAfterRecovery).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when the concurrent upload limit is reached', () => {
    let server: TestServer
    let releaseFirstUpload: () => void
    let firstUpload: PendingUpload
    let secondResult: { status: number; body: string }
    let recoveryResult: { status: number; body: string }
    let stateAfterRecovery: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      let signalFirstHandler: () => void
      const firstHandlerReached = new Promise<void>((resolve) => {
        signalFirstHandler = resolve
      })
      const firstHandlerGate = new Promise<void>((resolve) => {
        releaseFirstUpload = resolve
      })
      const handler = jest
        .fn()
        .mockImplementationOnce(async () => {
          signalFirstHandler()
          await firstHandlerGate
          return { status: 200 }
        })
        .mockResolvedValue({ status: 200 })
      server = await startMultipartServer({ capacity: 100, handler, maxConcurrentUploads: 1 })

      firstUpload = openChunkedUpload(server.baseUrl)
      finishUpload(firstUpload, 10)
      await firstHandlerReached

      const secondUpload = openChunkedUpload(server.baseUrl)
      finishUpload(secondUpload, 10)
      secondResult = await secondUpload.response

      releaseFirstUpload()
      await firstUpload.response

      const recoveryUpload = openChunkedUpload(server.baseUrl)
      finishUpload(recoveryUpload, 10)
      recoveryResult = await recoveryUpload.response
      stateAfterRecovery = server.inFlightUploadBudget.snapshot()
    })

    afterEach(async () => {
      releaseFirstUpload()
      firstUpload.request.destroy()
      await server.stop()
      jest.clearAllMocks()
    })

    it('should reject the additional concurrent upload', () => {
      expect(secondResult.status).toBe(503)
    })

    it('should admit a later upload after the slot is released', () => {
      expect(recoveryResult.status).toBe(200)
    })

    it('should release every byte and upload slot after recovery', () => {
      expect(stateAfterRecovery).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when a chunked request stalls before completing its body', () => {
    let server: TestServer
    let stalledUpload: PendingUpload
    let timeoutResult: { status: number; body: string }
    let recoveryResult: { status: number; body: string }
    let stateAfterTimeout: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      server = await startMultipartServer({ capacity: 100, maxConcurrentUploads: 1, timeoutMs: 25 })
      stalledUpload = openChunkedUpload(server.baseUrl)
      stalledUpload.request.write(Buffer.alloc(10))
      timeoutResult = await stalledUpload.response
      stateAfterTimeout = server.inFlightUploadBudget.snapshot()
      stalledUpload.request.destroy()

      const recoveryUpload = openChunkedUpload(server.baseUrl)
      finishUpload(recoveryUpload, 10)
      recoveryResult = await recoveryUpload.response
    })

    afterEach(async () => {
      stalledUpload.request.destroy()
      await server.stop()
      jest.clearAllMocks()
    })

    it('should respond with a 408', () => {
      expect(timeoutResult.status).toBe(408)
    })

    it('should release the concurrent upload slot', () => {
      expect(recoveryResult.status).toBe(200)
    })

    it('should release every reserved byte after the timeout', () => {
      expect(stateAfterTimeout).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when a stalled chunked request exceeds the shared byte budget', () => {
    let server: TestServer
    let upload: PendingUpload
    let result: { status: number; body: string }
    let stateAfterRejection: InFlightUploadBudgetSnapshot
    let releaseExistingUpload: () => void
    let onTelemetry: jest.Mock

    beforeEach(async () => {
      onTelemetry = jest.fn()
      server = await startMultipartServer({
        capacity: 100,
        maxSizeInBytes: 100,
        maxWireSizeInBytes: 1000,
        timeoutMs: 1000,
        onTelemetry
      })
      releaseExistingUpload = server.inFlightUploadBudget.acquire(90).lease!.release
      upload = openChunkedUpload(server.baseUrl)
      upload.request.write(Buffer.alloc(20))
      result = await upload.response
      stateAfterRejection = server.inFlightUploadBudget.snapshot()
    })

    afterEach(async () => {
      upload.request.destroy()
      releaseExistingUpload()
      await server.stop()
      jest.clearAllMocks()
    })

    it('should respond with 503 without waiting for the upload timeout', () => {
      expect(result.status).toBe(503)
    })

    it('should report a byte-capacity rejection', () => {
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'bytes' }))
    })

    it('should release its slot while preserving the existing reservation', () => {
      expect(stateAfterRejection).toMatchObject({ reservedBytes: 90, activeUploads: 1 })
    })
  })

  describe('when a stalled chunked request exceeds its payload limit', () => {
    let server: TestServer
    let upload: PendingUpload
    let result: { status: number; body: string }
    let stateAfterRejection: InFlightUploadBudgetSnapshot
    let onTelemetry: jest.Mock

    beforeEach(async () => {
      onTelemetry = jest.fn()
      server = await startMultipartServer({
        capacity: 100,
        maxSizeInBytes: 10,
        maxWireSizeInBytes: 1000,
        timeoutMs: 1000,
        onTelemetry
      })
      upload = openChunkedUpload(server.baseUrl)
      upload.request.write(Buffer.alloc(20))
      result = await upload.response
      stateAfterRejection = server.inFlightUploadBudget.snapshot()
    })

    afterEach(async () => {
      upload.request.destroy()
      await server.stop()
      jest.clearAllMocks()
    })

    it('should respond with 400 without waiting for the upload timeout', () => {
      expect(result.status).toBe(400)
    })

    it('should report a payload-size rejection', () => {
      expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: 'payload_size' }))
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterRejection).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when a chunked request exceeds its wire-size limit and then stalls', () => {
    let server: TestServer
    let upload: PendingUpload
    let result: { status: number; body: string }
    let stateAfterRejection: InFlightUploadBudgetSnapshot

    beforeEach(async () => {
      server = await startMultipartServer({ capacity: 100, maxWireSizeInBytes: 100, timeoutMs: 1000 })
      upload = openChunkedUpload(server.baseUrl)
      result = await upload.response
      stateAfterRejection = server.inFlightUploadBudget.snapshot()
    })

    afterEach(async () => {
      upload.request.destroy()
      await server.stop()
      jest.clearAllMocks()
    })

    it('should respond with 400 without waiting for the upload timeout', () => {
      expect(result.status).toBe(400)
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(stateAfterRejection).toMatchObject({ reservedBytes: 0, activeUploads: 0 })
    })
  })
})
