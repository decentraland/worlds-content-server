// TODO: move this helper to well-known-components

import { InvalidRequestError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@dcl/core-commons'
import busboy, { FieldInfo, FileInfo } from 'busboy'
import { createReadStream, createWriteStream } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { DeploymentFile } from '../types'

/**
 * An uploaded file. The bytes are streamed to a temp file on disk rather than buffered in memory,
 * so a deployment of large content files never holds them all in RAM at once. Consumers stream
 * the file from {@link UploadedFile.filepath} (for hashing/storing) or read it fully via
 * {@link readUploadedFile} (only for small files such as the entity JSON).
 */
export type UploadedFile = FileInfo & {
  fieldname: string
  /** Absolute path to the temp file holding the uploaded bytes. Removed once the handler returns. */
  filepath: string
  /** Number of bytes written to disk. */
  size: number
}

export type FormDataContext = IHttpServerComponent.DefaultContext & {
  formData: {
    fields: Record<
      string,
      FieldInfo & {
        fieldname: string
        value: string[]
      }
    >
    files: Record<string, UploadedFile>
  }
}

/** Reads a temp-backed uploaded file fully into memory. Use only for small files. */
export function readUploadedFile(file: UploadedFile): Promise<Buffer> {
  return readFile(file.filepath)
}

/** Wraps an uploaded file as a {@link DeploymentFile}, memoizing the full-buffer read. */
export function toDeploymentFile(file: UploadedFile): DeploymentFile {
  let buffered: Promise<Buffer> | undefined
  return {
    size: file.size,
    getStream: () => createReadStream(file.filepath),
    asBuffer: () => (buffered ??= readFile(file.filepath))
  }
}

const MB = 1024 * 1024

/**
 * Coarse limits applied while parsing multipart bodies. They comfortably fit a legitimate
 * world deployment while bounding how much an (unauthenticated) request can buffer in memory,
 * since the parser runs before any signature/size validation. Precise per-world size limits
 * are still enforced afterwards by the deployment validator.
 */
export const DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES = 350 * MB
const DEFAULT_LIMITS: busboy.Limits = {
  fieldNameSize: 200,
  fieldSize: MB,
  fields: 100,
  files: 10_000,
  parts: 10_100
}

/**
 * Maximum aggregate bytes that may be in flight (written to temp files) across all concurrent
 * uploads. The parser on POST /entities runs before any authentication, so without this ceiling
 * an unauthenticated client could open many concurrent uploads and exhaust resources.
 *
 * Uploads are streamed to disk rather than buffered in memory, so the limiting resource is the
 * container's ephemeral storage (e.g. 20 GB by default on Fargate), not RAM. The 4 GB default
 * leaves ample headroom while allowing many concurrent uploads; tune it to the available disk via
 * the MAX_IN_FLIGHT_UPLOAD_BYTES config. Requests grow their reservations from parsed payload
 * bytes as they arrive, so multipart framing is never charged against the buffered-byte budget.
 */
export const DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES = 4 * 1024 * MB
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 40
export const DEFAULT_MAX_IN_FLIGHT_UPLOAD_FILES = 40_000
export const DEFAULT_MAX_ORPHANED_UPLOAD_DIRECTORIES = 40
export const DEFAULT_MULTIPART_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000
export const DEFAULT_REJECTED_UPLOAD_DRAIN_TIMEOUT_MS = 5 * 1000
export const DEFAULT_MULTIPART_WIRE_OVERHEAD_IN_BYTES = 10 * MB
export const DEFAULT_MULTIPART_CLEANUP_RETRY_DELAYS_MS = [100, 1_000, 5_000] as const
export const MAX_WORLD_SETTINGS_UPLOAD_SIZE_IN_BYTES = 2 * MB

export type InFlightUploadBudgetSnapshot = {
  capacity: number
  reservedBytes: number
  orphanedBytes: number
  reservedFiles: number
  orphanedFiles: number
  orphanedDirectories: number
  activeUploads: number
  maxConcurrentUploads: number
  maxInFlightUploadFiles: number
  maxOrphanedUploadDirectories: number
}

export type InFlightUploadReleaseOptions = {
  /** Disk-backed bytes that remain after releasing the active upload. */
  retainBytes?: number
  /** Temporary files that remain after releasing the active upload. */
  retainFiles?: number
  /** Whether the temporary upload directory remains after releasing the active upload. */
  retainDirectory?: boolean
}

export type InFlightUploadLease = {
  /** Returns payload bytes currently reserved by this upload. */
  getReservedBytes: () => number
  /** Returns temporary files currently reserved by this upload. */
  getReservedFiles: () => number
  /** Changes the upload's payload-byte reservation if aggregate capacity permits it. */
  resize: (bytes: number) => boolean
  /** Changes the upload's temporary-file reservation if aggregate capacity permits it. */
  resizeFiles: (files: number) => boolean
  /** Releases active resources, optionally retaining resources left on disk after failed cleanup. */
  release: (options?: InFlightUploadReleaseOptions) => void
  /** Releases retained disk resources after background cleanup succeeds. */
  releaseRetainedResources: () => void
}

export type InFlightUploadAcquisition =
  | { lease: InFlightUploadLease; rejectionReason?: undefined }
  | { lease?: undefined; rejectionReason: 'bytes' | 'concurrency' | 'storage' }

export type InFlightUploadBudget = {
  capacity: number
  acquire: (bytes: number) => InFlightUploadAcquisition
  tryAcquireRejectedBodyDrain: () => (() => void) | undefined
  snapshot: () => InFlightUploadBudgetSnapshot
}

export type MultipartRejectionReason =
  | 'bytes'
  | 'concurrency'
  | 'timeout'
  | 'wire_size'
  | 'payload_size'
  | 'files'
  | 'storage'
  | 'invalid_multipart'

type MultipartTelemetryEventBase = {
  route: string
  actualBytes: number
  contentLengthPresent: boolean
  snapshot: InFlightUploadBudgetSnapshot
}

export type MultipartTelemetryEvent =
  | (MultipartTelemetryEventBase & { kind: 'completed' })
  | (MultipartTelemetryEventBase & { kind: 'rejected'; reason: MultipartRejectionReason })

export type MultipartCleanupErrorEvent = {
  route: string
  error: Error
  /** Zero for the initial cleanup, then one-based for background retries. */
  attempt: number
  /** Whether another retry is scheduled after this failure. */
  willRetry: boolean
}

export type MultipartFileSystem = {
  createWriteStream: typeof createWriteStream
  mkdtemp: typeof mkdtemp
  rm: typeof rm
}

export type MultipartParserOptions = {
  /** Maximum total bytes (across all files and fields) buffered before the request is rejected. */
  maxSizeInBytes?: number
  /** Maximum full multipart wire size, including boundaries and part headers. */
  maxWireSizeInBytes?: number
  /** Overrides for the busboy limits (count/size caps). Defaults to {@link DEFAULT_LIMITS}. */
  limits?: busboy.Limits
  /** Shared aggregate buffered-bytes budget across concurrent uploads. */
  inFlightUploadBudget?: InFlightUploadBudget
  /** Maximum time allowed to receive and parse the request body. */
  uploadTimeoutMs?: number
  /** Stable route label used by upload telemetry. */
  route?: string
  /** Receives completion and rejection events for logging and metrics. */
  onTelemetry?: (event: MultipartTelemetryEvent) => void
  /** Receives temporary-directory cleanup failures for logging and metrics. */
  onCleanupError?: (event: MultipartCleanupErrorEvent) => void
  /** Filesystem operations used for temporary uploads. Defaults to Node's filesystem. */
  fileSystem?: MultipartFileSystem
  /** Delays for bounded background retries after a temporary-directory cleanup failure. */
  cleanupRetryDelaysMs?: readonly number[]
}

function validatePositiveByteLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer, got ${value}`)
  }
}

function validateReservationBytes(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer, got ${value}`)
  }
}

function notifySafely<T>(listener: ((event: T) => void) | undefined, event: T): void {
  try {
    listener?.(event)
  } catch {
    // Observability must never change admission state or the HTTP response.
  }
}

class MultipartRejectionError extends Error {
  constructor(
    readonly reason: MultipartRejectionReason,
    message: string,
    readonly actualBytes: number
  ) {
    super(message)
  }
}

class UploadCapacityError extends MultipartRejectionError {
  constructor(actualBytes: number) {
    super('bytes', 'Server is buffering too many uploads, please retry shortly.', actualBytes)
  }
}

class UploadTimeoutError extends MultipartRejectionError {
  constructor(actualBytes: number) {
    super('timeout', 'The multipart upload timed out.', actualBytes)
  }
}

class UploadWireSizeError extends MultipartRejectionError {
  constructor(actualBytes: number) {
    super('wire_size', 'The multipart request is too large.', actualBytes)
  }
}

class UploadPayloadSizeError extends MultipartRejectionError {
  constructor(message: string, actualBytes: number) {
    super('payload_size', message, actualBytes)
  }
}

class UploadStorageError extends MultipartRejectionError {
  constructor(actualBytes: number) {
    super('storage', 'The server could not store the multipart upload, please retry shortly.', actualBytes)
  }
}

class UploadFileCapacityError extends MultipartRejectionError {
  constructor(actualBytes: number) {
    super('files', 'Server is buffering too many upload files, please retry shortly.', actualBytes)
  }
}

class InvalidMultipartBodyError extends MultipartRejectionError {
  constructor(message: string, actualBytes: number) {
    super('invalid_multipart', message, actualBytes)
  }
}

/**
 * Lets an early-rejected request finish sending without retaining its body. Leaving it unread can
 * occupy a keep-alive connection and make a healthy request queued behind it appear to hang.
 */
function drainRequestBody(body: unknown, timeoutMs: number, inFlightUploadBudget: InFlightUploadBudget): void {
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

/**
 * Creates a byte budget shared by every multipart route that receives the returned object.
 *
 * @param capacity Maximum number of bytes that may be reserved concurrently.
 * @param maxConcurrentUploads Maximum simultaneous admitted uploads and, independently, rejected-body drains.
 * @param onStateChange Receives admitted-upload reservation state changes.
 * @param maxInFlightUploadFiles Maximum temporary files across active and orphaned uploads.
 * @param maxOrphanedUploadDirectories Maximum failed-cleanup directories tolerated before admission stops.
 * @returns A synchronous reservation and rejected-body drain tracker for multipart requests.
 */
export function createInFlightUploadBudget(
  capacity: number = DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES,
  maxConcurrentUploads: number = DEFAULT_MAX_CONCURRENT_UPLOADS,
  onStateChange?: (snapshot: InFlightUploadBudgetSnapshot) => void,
  maxInFlightUploadFiles: number = DEFAULT_MAX_IN_FLIGHT_UPLOAD_FILES,
  maxOrphanedUploadDirectories: number = DEFAULT_MAX_ORPHANED_UPLOAD_DIRECTORIES
): InFlightUploadBudget {
  validatePositiveByteLimit('maxInFlightUploadBytes', capacity)
  validatePositiveByteLimit('maxConcurrentUploads', maxConcurrentUploads)
  validatePositiveByteLimit('maxInFlightUploadFiles', maxInFlightUploadFiles)
  validatePositiveByteLimit('maxOrphanedUploadDirectories', maxOrphanedUploadDirectories)
  let reservedBytes = 0
  let orphanedBytes = 0
  let reservedFiles = 0
  let orphanedFiles = 0
  let orphanedDirectories = 0
  let activeUploads = 0
  let activeRejectedBodyDrains = 0

  const snapshot = (): InFlightUploadBudgetSnapshot => ({
    capacity,
    reservedBytes,
    orphanedBytes,
    reservedFiles,
    orphanedFiles,
    orphanedDirectories,
    activeUploads,
    maxConcurrentUploads,
    maxInFlightUploadFiles,
    maxOrphanedUploadDirectories
  })
  const emitState = (): void => notifySafely(onStateChange, snapshot())

  return {
    capacity,
    snapshot,
    tryAcquireRejectedBodyDrain(): (() => void) | undefined {
      if (activeRejectedBodyDrains >= maxConcurrentUploads) {
        return undefined
      }
      activeRejectedBodyDrains++
      let released = false
      return () => {
        if (!released) {
          released = true
          activeRejectedBodyDrains--
        }
      }
    },
    acquire(bytes: number) {
      validateReservationBytes('upload reservation', bytes)
      if (activeUploads >= maxConcurrentUploads) {
        return { rejectionReason: 'concurrency' as const }
      }
      if (orphanedDirectories >= maxOrphanedUploadDirectories) {
        return { rejectionReason: 'storage' as const }
      }
      if (reservedBytes + bytes > capacity) {
        return { rejectionReason: 'bytes' as const }
      }
      reservedBytes += bytes
      activeUploads++
      emitState()
      let leaseBytes = bytes
      let leaseFiles = 0
      let released = false
      let retainedBytes = 0
      let retainedFiles = 0
      let retainedDirectory = false

      return {
        lease: {
          getReservedBytes: () => leaseBytes,
          getReservedFiles: () => leaseFiles,
          resize(nextBytes: number): boolean {
            validateReservationBytes('upload reservation', nextBytes)
            if (released || reservedBytes - leaseBytes + nextBytes > capacity) {
              return false
            }
            reservedBytes += nextBytes - leaseBytes
            leaseBytes = nextBytes
            emitState()
            return true
          },
          resizeFiles(nextFiles: number): boolean {
            validateReservationBytes('upload file reservation', nextFiles)
            if (released || reservedFiles - leaseFiles + nextFiles > maxInFlightUploadFiles) {
              return false
            }
            reservedFiles += nextFiles - leaseFiles
            leaseFiles = nextFiles
            emitState()
            return true
          },
          release(options?: InFlightUploadReleaseOptions): void {
            if (!released) {
              const nextRetainedBytes = options?.retainBytes ?? 0
              const nextRetainedFiles = options?.retainFiles ?? 0
              validateReservationBytes('retained upload bytes', nextRetainedBytes)
              validateReservationBytes('retained upload files', nextRetainedFiles)
              if (nextRetainedBytes > leaseBytes || nextRetainedFiles > leaseFiles) {
                throw new Error('Retained upload resources cannot exceed the active reservation')
              }
              released = true
              retainedBytes = nextRetainedBytes
              retainedFiles = nextRetainedFiles
              retainedDirectory = options?.retainDirectory ?? false
              reservedBytes -= leaseBytes - retainedBytes
              reservedFiles -= leaseFiles - retainedFiles
              orphanedBytes += retainedBytes
              orphanedFiles += retainedFiles
              if (retainedDirectory) orphanedDirectories++
              activeUploads--
              emitState()
            }
          },
          releaseRetainedResources(): void {
            if (retainedBytes > 0 || retainedFiles > 0 || retainedDirectory) {
              reservedBytes -= retainedBytes
              orphanedBytes -= retainedBytes
              reservedFiles -= retainedFiles
              orphanedFiles -= retainedFiles
              if (retainedDirectory) orphanedDirectories--
              retainedBytes = 0
              retainedFiles = 0
              retainedDirectory = false
              emitState()
            }
          }
        }
      }
    }
  }
}

// Used by callers that do not need to customize the process-wide upload budget.
const defaultInFlightUploadBudget = createInFlightUploadBudget()

export function multipartParserWrapper<Ctx extends FormDataContext, T extends IHttpServerComponent.IResponse>(
  handler: (ctx: Ctx) => Promise<T>,
  options?: MultipartParserOptions
): (ctx: IHttpServerComponent.DefaultContext) => Promise<T> {
  const maxSizeInBytes = options?.maxSizeInBytes ?? DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
  const maxWireSizeInBytes = options?.maxWireSizeInBytes ?? maxSizeInBytes + DEFAULT_MULTIPART_WIRE_OVERHEAD_IN_BYTES
  const inFlightUploadBudget = options?.inFlightUploadBudget ?? defaultInFlightUploadBudget
  const uploadTimeoutMs = options?.uploadTimeoutMs ?? DEFAULT_MULTIPART_UPLOAD_TIMEOUT_MS
  const fileSystem: MultipartFileSystem = options?.fileSystem ?? { createWriteStream, mkdtemp, rm }
  const cleanupRetryDelaysMs = options?.cleanupRetryDelaysMs ?? DEFAULT_MULTIPART_CLEANUP_RETRY_DELAYS_MS

  validatePositiveByteLimit('maxSizeInBytes', maxSizeInBytes)
  validatePositiveByteLimit('maxWireSizeInBytes', maxWireSizeInBytes)
  validatePositiveByteLimit('maxInFlightUploadBytes', inFlightUploadBudget.capacity)
  validatePositiveByteLimit('uploadTimeoutMs', uploadTimeoutMs)
  for (const delayMs of cleanupRetryDelaysMs) {
    validateReservationBytes('multipart cleanup retry delay', delayMs)
  }
  if (inFlightUploadBudget.capacity < maxSizeInBytes) {
    throw new Error(
      `maxInFlightUploadBytes (${inFlightUploadBudget.capacity}) must be greater than or equal to maxSizeInBytes (${maxSizeInBytes})`
    )
  }
  if (maxWireSizeInBytes < maxSizeInBytes) {
    throw new Error(
      `maxWireSizeInBytes (${maxWireSizeInBytes}) must be greater than or equal to maxSizeInBytes (${maxSizeInBytes})`
    )
  }

  return async function (ctx): Promise<T> {
    const emitRejection = (
      reason: MultipartRejectionReason,
      actualBytes: number,
      contentLengthPresent: boolean
    ): void => {
      notifySafely(options?.onTelemetry, {
        kind: 'rejected',
        route: options?.route ?? 'unknown',
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
      throw new InvalidRequestError('The multipart request is too large.')
    }

    // Bound aggregate temporary disk usage: this parser runs before any auth on POST /entities, so
    // it must self-limit how much it writes at once. Every request acquires a concurrency slot and
    // grows its reservation synchronously from parsed payload bytes. Content-Length cannot be used
    // as a payload reservation because it includes multipart framing and can cause false capacity
    // rejections. Requests that exceed either budget are shed with 503. The reservation is held
    // until the handler completes, since the temp files and fields live for its duration.
    const acquisition = inFlightUploadBudget.acquire(0)
    if (!acquisition.lease) {
      drainRequestBody(ctx.request.body, uploadTimeoutMs, inFlightUploadBudget)
      emitRejection(acquisition.rejectionReason, 0, declaredSize !== undefined)
      return {
        status: 503,
        headers: { 'Retry-After': '5' },
        body: {
          error: 'Service Unavailable',
          message:
            acquisition.rejectionReason === 'concurrency'
              ? 'Server is handling too many concurrent uploads, please retry shortly.'
              : acquisition.rejectionReason === 'storage'
                ? 'The server could not store the multipart upload, please retry shortly.'
                : 'Server is buffering too many uploads, please retry shortly.'
        }
        // The wrapper is typed to the handler's response type; this shed response is a valid IResponse.
      } as unknown as T
    }
    const lease = acquisition.lease
    try {
      const result = await parseAndHandle(ctx, lease, uploadTimeoutMs)
      notifySafely(options?.onTelemetry, {
        kind: 'completed',
        route: options?.route ?? 'unknown',
        actualBytes: lease.getReservedBytes(),
        contentLengthPresent: declaredSize !== undefined,
        snapshot: inFlightUploadBudget.snapshot()
      })
      return result
    } catch (error) {
      if (error instanceof MultipartRejectionError) {
        emitRejection(error.reason, error.actualBytes, declaredSize !== undefined)
        if (
          error.reason !== 'bytes' &&
          error.reason !== 'files' &&
          error.reason !== 'timeout' &&
          error.reason !== 'storage'
        ) {
          throw new InvalidRequestError(error.message)
        }
        return {
          status: error.reason === 'timeout' ? 408 : 503,
          headers: error.reason === 'timeout' ? {} : { 'Retry-After': '5' },
          body: {
            error: error.reason === 'timeout' ? 'Request Timeout' : 'Service Unavailable',
            message: error.message
          }
        } as unknown as T
      }
      throw error
    } finally {
      lease.release()
    }
  }

  async function parseAndHandle(
    ctx: IHttpServerComponent.DefaultContext,
    lease: InFlightUploadLease,
    timeoutMs: number
  ): Promise<T> {
    let formDataParser: busboy.Busboy
    try {
      formDataParser = busboy({
        headers: {
          'content-type': ctx.request.headers.get('content-type') || undefined
        },
        limits: { ...DEFAULT_LIMITS, fileSize: maxSizeInBytes, ...options?.limits }
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
      if (totalBytes > lease.getReservedBytes() && !lease.resize(totalBytes)) {
        abortParsing(new UploadCapacityError(totalBytes))
        return false
      }
      return true
    }

    function reportCleanupError(error: unknown, attempt: number, willRetry: boolean): void {
      notifySafely(options?.onCleanupError, {
        route: options?.route ?? 'unknown',
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
      abortParsing(new InvalidMultipartBodyError('The multipart request has too many parts.', totalBytes))
    )
    formDataParser.on('filesLimit', () =>
      abortParsing(new InvalidMultipartBodyError('The multipart request has too many files.', totalBytes))
    )
    formDataParser.on('fieldsLimit', () =>
      abortParsing(new InvalidMultipartBodyError('The multipart request has too many fields.', totalBytes))
    )

    /**
     * Emitted for each new non-file field found.
     * All field values are stored as arrays to support multiple values with the same name.
     */
    formDataParser.on('field', function (name: string, value: string, info: FieldInfo): void {
      const bytes = Buffer.byteLength(value)
      if (parsingError) {
        return
      }
      if (info.valueTruncated) {
        abortParsing(new UploadPayloadSizeError('The multipart request is too large.', totalBytes + bytes))
        return
      }
      if (!accountBytes(bytes)) {
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
              callback(new UploadWireSizeError(lease.getReservedBytes()))
              return
            }
            callback(null, chunk)
          }
        })
        abortController = new AbortController()
        const timeout = setTimeout(() => abortParsing(new UploadTimeoutError(lease.getReservedBytes())), timeoutMs)
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

export function isDefinedMultipartField(
  field: (FieldInfo & { value?: string[] }) | undefined
): field is FieldInfo & { value: string[] } {
  return (
    !!field &&
    !!field.value &&
    field.value.length > 0 &&
    field.value.every((v) => v !== '' && v !== null && v !== undefined)
  )
}
