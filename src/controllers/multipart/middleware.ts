// TODO: move this helper to well-known-components

import { InvalidRequestError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@dcl/core-commons'
import busboy, { FieldInfo, FileInfo } from 'busboy'
import { createWriteStream } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { IInFlightUploadBudget, InFlightUploadLease } from '../../adapters/in-flight-upload-budget'
import { FormDataContext } from '../../logic/form-data'
import {
  DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES,
  DEFAULT_MULTIPART_UPLOAD_TIMEOUT_MS,
  validatePositiveByteLimit,
  validateReservationBytes
} from '../../logic/upload-limits'
import { notifySafely } from '../../logic/utils'
import {
  InvalidMultipartBodyError,
  MultipartRejectionError,
  PayloadTooLargeError,
  UploadCapacityError,
  UploadCountLimitError,
  UploadFileCapacityError,
  UploadLimitError,
  UploadPayloadSizeError,
  UploadStorageError,
  UploadTimeoutError,
  UploadUnavailableError,
  UploadWireSizeError
} from './errors'
import {
  DEFAULT_LIMITS,
  DEFAULT_MULTIPART_CLEANUP_RETRY_DELAYS_MS,
  DEFAULT_MULTIPART_WIRE_OVERHEAD_IN_BYTES,
  DEFAULT_REJECTED_UPLOAD_DRAIN_TIMEOUT_MS
} from './limits'
import { MultipartFileSystem, MultipartParserOptions, MultipartRejectionReason } from './types'
import { RequestArrivalContext } from '../request-arrival'

/**
 * Lets an early-rejected request finish sending without retaining its body. Leaving it unread can
 * occupy a keep-alive connection and make a healthy request queued behind it appear to hang.
 */
function drainRequestBody(body: unknown, timeoutMs: number, inFlightUploadBudget: IInFlightUploadBudget): void {
  if (!body) {
    return
  }
  let releaseDrain: (() => void) | undefined
  try {
    const stream = body instanceof Readable ? body : Readable.fromWeb(body as import('stream/web').ReadableStream)
    releaseDrain = inFlightUploadBudget.tryAcquireRejectedBodyDrain()
    if (!releaseDrain) {
      stream.destroy()
      return
    }
    let finished = false
    const finish = (): void => {
      if (!finished) {
        finished = true
        clearTimeout(timeout)
        releaseDrain?.()
      }
    }
    const timeout = setTimeout(
      () => {
        finish()
        stream.destroy()
      },
      Math.min(timeoutMs, DEFAULT_REJECTED_UPLOAD_DRAIN_TIMEOUT_MS)
    )
    timeout.unref()
    stream.once('end', finish)
    stream.once('close', finish)
    stream.once('error', finish)
    stream.resume()
  } catch {
    releaseDrain?.()
    // The body may already be locked or closed. There is nothing left for this parser to consume.
  }
}

export function multipartParserWrapper<Ctx extends FormDataContext, T extends IHttpServerComponent.IResponse>(
  handler: (ctx: Ctx) => Promise<T>,
  options: MultipartParserOptions
): (ctx: IHttpServerComponent.DefaultContext) => Promise<T> {
  const maxSizeInBytes = options.maxSizeInBytes ?? DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
  const maxWireSizeInBytes = options.maxWireSizeInBytes ?? maxSizeInBytes + DEFAULT_MULTIPART_WIRE_OVERHEAD_IN_BYTES
  const inFlightUploadBudget = options.inFlightUploadBudget
  const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_MULTIPART_UPLOAD_TIMEOUT_MS
  const fileSystem: MultipartFileSystem = options.fileSystem ?? { createWriteStream, mkdtemp, rm }
  const cleanupRetryDelaysMs = options.cleanupRetryDelaysMs ?? DEFAULT_MULTIPART_CLEANUP_RETRY_DELAYS_MS
  const repeatableFields = new Set(options.repeatableFields ?? [])

  validatePositiveByteLimit('maxSizeInBytes', maxSizeInBytes)
  validatePositiveByteLimit('maxWireSizeInBytes', maxWireSizeInBytes)
  validatePositiveByteLimit('maxInFlightUploadBytes', inFlightUploadBudget.capacity)
  validatePositiveByteLimit('uploadTimeoutMs', uploadTimeoutMs)
  for (const delayMs of cleanupRetryDelaysMs) {
    validateReservationBytes('multipart cleanup retry delay', delayMs)
  }
  const limits: busboy.Limits = { ...DEFAULT_LIMITS, fileSize: maxSizeInBytes, ...options.limits }
  // busboy truncates a field or file that reaches its size limit, so allow one more byte.
  const parserLimits: busboy.Limits = {
    ...limits,
    ...(limits.fieldSize !== undefined && { fieldSize: limits.fieldSize + 1 }),
    ...(limits.fileSize !== undefined && { fileSize: limits.fileSize + 1 })
  }
  const maxFilesPerRequest = limits.files ?? Infinity
  // One maximum-size upload with every file part it may carry must fit the budget on its own.
  const maxRequestCharge = maxSizeInBytes + maxFilesPerRequest * inFlightUploadBudget.uploadFileOverheadBytes
  if (!(inFlightUploadBudget.capacity >= maxRequestCharge)) {
    throw new Error(
      `maxInFlightUploadBytes (${inFlightUploadBudget.capacity}) must be greater than or equal to maxSizeInBytes (${maxSizeInBytes}) + ${maxFilesPerRequest} files × uploadFileOverheadBytes (${inFlightUploadBudget.uploadFileOverheadBytes})`
    )
  }
  if (maxWireSizeInBytes < maxSizeInBytes) {
    throw new Error(
      `maxWireSizeInBytes (${maxWireSizeInBytes}) must be greater than or equal to maxSizeInBytes (${maxSizeInBytes})`
    )
  }

  return async function (ctx): Promise<T> {
    // Unstamped routes measure from parser entry instead of arrival.
    const { requestArrivedAt } = ctx as Partial<RequestArrivalContext>
    const arrivedAt = typeof requestArrivedAt === 'number' ? requestArrivedAt : Date.now()
    const reportReceived = (outcome: 'completed' | 'rejected'): void => {
      notifySafely(options.onBodyReceived, {
        route: options.route ?? 'unknown',
        outcome,
        durationSeconds: (Date.now() - arrivedAt) / 1000
      })
    }
    const emitRejection = (
      reason: MultipartRejectionReason,
      actualBytes: number,
      contentLengthPresent: boolean
    ): void => {
      reportReceived('rejected')
      notifySafely(options.onTelemetry, {
        kind: 'rejected',
        route: options.route ?? 'unknown',
        reason,
        actualBytes,
        contentLengthPresent,
        snapshot: inFlightUploadBudget.snapshot()
      })
    }

    // Reject obviously-oversized uploads up front, before reading or buffering any of the body.
    // A request that lies about (or omits) Content-Length is still bounded by the streaming
    // guard further down, which stops buffering once totalBytes exceeds maxSizeInBytes.
    const contentLength = ctx.request.headers.get('content-length')
    if (contentLength !== null && !/^\d+$/.test(contentLength)) {
      drainRequestBody(ctx.request.body, uploadTimeoutMs, inFlightUploadBudget)
      emitRejection('invalid_multipart', 0, true)
      throw new InvalidRequestError('Invalid Content-Length header.')
    }
    const declaredSize = contentLength === null ? undefined : Number(contentLength)
    if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize > maxWireSizeInBytes)) {
      drainRequestBody(ctx.request.body, uploadTimeoutMs, inFlightUploadBudget)
      emitRejection('wire_size', 0, true)
      throw new PayloadTooLargeError('The multipart request is too large.')
    }

    // Bound aggregate temporary disk usage: this parser runs before any auth on POST /entities, so
    // it must self-limit how much it writes at once. Every request reserves the per-request minimum
    // and grows its charge synchronously from parsed payload bytes and file parts. Content-Length
    // cannot be used as a payload reservation because it includes multipart framing and can cause
    // false capacity rejections. Requests that exceed the budget are shed with 503. The reservation
    // is held until the handler completes, since the temp files and fields live for its duration.
    const acquisition = inFlightUploadBudget.acquire(0)
    if (!acquisition.lease) {
      drainRequestBody(ctx.request.body, uploadTimeoutMs, inFlightUploadBudget)
      emitRejection(acquisition.rejectionReason, 0, declaredSize !== undefined)
      throw acquisition.rejectionReason === 'storage' ? new UploadStorageError(0) : new UploadCapacityError(0)
    }
    const lease = acquisition.lease
    try {
      const result = await parseAndHandle(ctx, lease, uploadTimeoutMs, declaredSize, () => reportReceived('completed'))
      notifySafely(options.onTelemetry, {
        kind: 'completed',
        route: options.route ?? 'unknown',
        actualBytes: lease.getPayloadBytes(),
        contentLengthPresent: declaredSize !== undefined,
        snapshot: inFlightUploadBudget.snapshot()
      })
      return result
    } catch (error) {
      if (error instanceof MultipartRejectionError) {
        emitRejection(error.reason, error.actualBytes, declaredSize !== undefined)
        if (error instanceof UploadLimitError) {
          throw new PayloadTooLargeError(error.message)
        }
        if (!(error instanceof UploadUnavailableError) && !(error instanceof UploadTimeoutError)) {
          throw new InvalidRequestError(error.message)
        }
      }
      throw error
    } finally {
      lease.release()
    }
  }

  async function parseAndHandle(
    ctx: IHttpServerComponent.DefaultContext,
    lease: InFlightUploadLease,
    timeoutMs: number,
    declaredBytes: number | undefined,
    onReceived: () => void
  ): Promise<T> {
    let formDataParser: busboy.Busboy
    try {
      formDataParser = busboy({
        headers: {
          'content-type': ctx.request.headers.get('content-type') || undefined
        },
        limits: parserLimits
      })
    } catch (error: any) {
      throw new InvalidMultipartBodyError(error.message || 'Invalid multipart form data', 0)
    }

    // Null-prototype maps so an attacker-controlled field/file name such as `__proto__` or
    // `constructor` is stored as a plain key. On a plain object a field named `__proto__` makes
    // `if (fields[name])` read Object.prototype (truthy) and then `fields[name].value.push(...)`
    // throw, aborting the request.
    const fields: FormDataContext['formData']['fields'] = Object.create(null)
    const files: FormDataContext['formData']['files'] = Object.create(null)
    // A repeated part would be written to disk but only one copy kept, escaping byte accounting.
    const seenNames = new Map<string, 'field' | 'file'>()
    function rejectIfDuplicate(name: string, kind: 'field' | 'file'): boolean {
      const seenAs = seenNames.get(name)
      if (seenAs && !(kind === 'field' && seenAs === 'field' && repeatableFields.has(name))) {
        abortParsing(new InvalidMultipartBodyError(`Duplicate form field '${name}'`, totalBytes))
        return true
      }
      seenNames.set(name, kind)
      return false
    }

    // Uploaded files are streamed to temp files under this directory and removed once the handler
    // returns, so large content files are never held in memory in full.
    const tmpDir = await fileSystem.mkdtemp(join(tmpdir(), 'wcs-upload-'))
    const fileWrites: Promise<void>[] = []
    const fileWriteStreams: ReturnType<typeof createWriteStream>[] = []
    let fileIndex = 0

    let totalBytes = 0
    let totalFileBytes = 0
    let totalFiles = 0
    let parsingError: MultipartRejectionError | undefined
    let abortController: AbortController | undefined

    // Preserve and propagate the first terminal condition. Aborting the pipeline tears down the
    // request, wire guard, and busboy together, so a client cannot retain capacity by stalling
    // after the request has already become invalid.
    function abortParsing(error: MultipartRejectionError): void {
      if (!parsingError) {
        parsingError = error
      }
      abortController?.abort(parsingError)
    }

    function accountBytes(bytes: number): boolean {
      totalBytes += bytes
      if (totalBytes > maxSizeInBytes) {
        abortParsing(new UploadPayloadSizeError('The multipart request is too large.', totalBytes))
        return false
      }
      if (totalBytes > lease.getPayloadBytes() && !lease.resize(totalBytes)) {
        abortParsing(new UploadCapacityError(totalBytes))
        return false
      }
      return true
    }

    function reportCleanupError(error: unknown, attempt: number, willRetry: boolean): void {
      notifySafely(options.onCleanupError, {
        route: options.route ?? 'unknown',
        error: error instanceof Error ? error : new Error(String(error)),
        attempt,
        willRetry
      })
    }

    function scheduleCleanupRetry(attempt: number): void {
      const delayMs = cleanupRetryDelaysMs[attempt]
      if (delayMs === undefined) {
        return
      }
      const retry = setTimeout(async () => {
        try {
          await fileSystem.rm(tmpDir, { recursive: true, force: true })
          lease.releaseRetainedResources()
        } catch (error) {
          reportCleanupError(error, attempt + 1, cleanupRetryDelaysMs[attempt + 1] !== undefined)
          scheduleCleanupRetry(attempt + 1)
        }
      }, delayMs)
      retry.unref()
    }

    formDataParser.on('partsLimit', () =>
      abortParsing(new UploadCountLimitError('The multipart request has too many parts.', totalBytes))
    )
    formDataParser.on('filesLimit', () =>
      abortParsing(new UploadCountLimitError('The multipart request has too many files.', totalBytes))
    )
    formDataParser.on('fieldsLimit', () =>
      abortParsing(
        new UploadCountLimitError(
          `The multipart request has too many fields. The maximum allowed is ${limits.fields}.`,
          totalBytes
        )
      )
    )

    /**
     * Emitted for each new non-file field found.
     * Values are arrays; only names in `repeatableFields` may carry more than one.
     */
    formDataParser.on('field', function (name: string, value: string, info: FieldInfo): void {
      const bytes = Buffer.byteLength(value)
      if (parsingError) {
        return
      }
      if (info.valueTruncated) {
        abortParsing(
          new UploadPayloadSizeError(
            `Field '${name}' is too large. The maximum allowed size per field is ${limits.fieldSize} bytes.`,
            totalBytes + bytes
          )
        )
        return
      }
      if (rejectIfDuplicate(name, 'field') || !accountBytes(bytes)) {
        return
      }

      if (fields[name]) {
        // Field already exists, append to array
        fields[name].value.push(value)
      } else {
        // First occurrence, create array with single value
        fields[name] = {
          fieldname: name,
          value: [value],
          ...info
        }
      }
    })
    formDataParser.on('file', function (name: string, stream: Readable, info: FileInfo) {
      // Checked on the part's headers, before any of its bytes are written or charged.
      if (rejectIfDuplicate(name, 'file')) {
        // Aborting destroys the parser, which errors this part's stream too.
        stream.on('error', () => undefined).resume()
        return
      }
      const nextFileCount = totalFiles + 1
      if (!lease.resizeFiles(nextFileCount)) {
        // Keep draining this file through busboy instead of aborting synchronously from its `file`
        // callback. Immediate teardown here can race busboy's creation of the part stream. No temp
        // file is created, so disk/file capacity remains bounded while the wire-size guard drains.
        parsingError ??= new UploadFileCapacityError(totalBytes)
        stream.on('error', () => {
          // The shared parser error is returned after draining or timeout teardown.
        })
        stream.resume()
        return
      }
      totalFiles = nextFileCount
      const filepath = join(tmpDir, String(fileIndex++))
      const writeStream = fileSystem.createWriteStream(filepath)
      fileWriteStreams.push(writeStream)
      let size = 0
      let aborted = false

      stream.on('limit', function () {
        abortParsing(new UploadPayloadSizeError('An uploaded file exceeds the maximum allowed size.', totalBytes))
      })

      const written = new Promise<void>((resolve) => {
        let finalized = false
        const finalize = (): void => {
          if (!finalized) {
            finalized = true
            files[name] = { ...info, fieldname: name, filepath, size }
            resolve()
          }
        }
        stream.on('data', function (data) {
          if (aborted) {
            return
          }
          if (parsingError || !accountBytes(data.length)) {
            aborted = true
            writeStream.end()
            return
          }
          size += data.length
          totalFileBytes += data.length
          // Respect backpressure so a slow disk doesn't let chunks pile up in memory.
          if (!writeStream.write(data)) {
            stream.pause()
            writeStream.once('drain', () => stream.resume())
          }
        })
        stream.on('end', function () {
          if (!aborted) {
            writeStream.end()
          }
        })
        stream.on('error', function () {
          aborted = true
          writeStream.destroy()
        })
        stream.on('close', function () {
          if (!writeStream.writableEnded) {
            aborted = true
            writeStream.destroy()
          }
        })
        writeStream.on('error', function () {
          abortParsing(new UploadStorageError(totalBytes))
          aborted = true
        })
        writeStream.on('close', finalize)
      })
      fileWrites.push(written)
    })

    const newContext: Ctx = Object.assign(Object.create(ctx), { formData: { fields, files } })

    try {
      try {
        // `.pipe()` doesn't propagate teardown: a client disconnecting mid-upload would leave busboy
        // waiting forever (and the temp dir below never cleaned up). `pipeline` tears all streams
        // down if any stream errors. Parser callbacks use the shared abort controller to do the same
        // as soon as a payload or capacity limit is reached, preserving the first typed cause.
        //
        // `@dcl/http-server` exposes the native request body as a web `ReadableStream`; normalize it
        // to a Node `Readable` so busboy can consume it (callers/tests may also pass a Node `Readable`
        // directly). Teardown still propagates — destroying the Readable cancels the web stream.
        const requestBody: unknown = ctx.request.body
        if (!requestBody) {
          throw new InvalidMultipartBodyError('Missing multipart request body', totalBytes)
        }
        const bodyStream =
          requestBody instanceof Readable
            ? requestBody
            : Readable.fromWeb(requestBody as import('stream/web').ReadableStream)
        let wireBytes = 0
        const wireSizeGuard = new Transform({
          transform(chunk: Buffer, _encoding, callback): void {
            wireBytes += chunk.length
            if (wireBytes > maxWireSizeInBytes) {
              callback(new UploadWireSizeError(lease.getPayloadBytes()))
              return
            }
            callback(null, chunk)
          }
        })
        abortController = new AbortController()
        const timeout = setTimeout(
          () => abortParsing(new UploadTimeoutError(lease.getPayloadBytes(), timeoutMs, wireBytes, declaredBytes)),
          timeoutMs
        )
        try {
          await pipeline(bodyStream, wireSizeGuard, formDataParser, { signal: abortController.signal })
        } finally {
          clearTimeout(timeout)
        }
      } catch (error: any) {
        if (parsingError) {
          throw parsingError
        }
        if (error instanceof MultipartRejectionError) {
          throw error
        }
        throw new InvalidMultipartBodyError(error.message || 'Invalid multipart form data', totalBytes)
      }

      // Wait for every temp file to finish flushing before the handler reads them.
      await Promise.all(fileWrites)
      if (parsingError) {
        throw parsingError
      }

      // Retain exactly the parsed payload bytes that remain buffered in fields/temp files while
      // the handler runs.
      if (!lease.resize(totalBytes)) {
        throw new UploadCapacityError(totalBytes)
      }

      onReceived()
      return await handler(newContext)
    } finally {
      // Close every descriptor before deleting the directory and releasing the outer lease. On
      // Unix an unlinked-but-open file still consumes disk blocks, so releasing first would make
      // the byte gauge temporarily under-report real ephemeral-storage usage.
      for (const writeStream of fileWriteStreams) {
        if (!writeStream.closed) {
          writeStream.destroy()
        }
      }
      await Promise.allSettled(fileWrites)
      try {
        await fileSystem.rm(tmpDir, { recursive: true, force: true })
      } catch (error) {
        // Fields have already been released from memory. Retain only disk-backed payload and file
        // resources, plus the orphaned directory itself, until background cleanup succeeds.
        lease.release({ retainBytes: totalFileBytes, retainFiles: totalFiles, retainDirectory: true })
        reportCleanupError(error, 0, cleanupRetryDelaysMs[0] !== undefined)
        scheduleCleanupRetry(0)
      }
    }
  }
}
