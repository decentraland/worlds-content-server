// TODO: move this helper to well-known-components

import { InvalidRequestError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import busboy, { FieldInfo, FileInfo } from 'busboy'
import { createReadStream, createWriteStream } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
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
 * the MAX_IN_FLIGHT_UPLOAD_BYTES config. A request reserves its declared Content-Length (capped at
 * the per-request limit; the full limit when none is declared), so small uploads barely count
 * while large ones are bounded.
 */
export const DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES = 4 * 1024 * MB

// Module-level so the budget is shared across every route that buffers multipart bodies.
let inFlightUploadBytes = 0

export type MultipartParserOptions = {
  /** Maximum total bytes (across all files and fields) buffered before the request is rejected. */
  maxSizeInBytes?: number
  /** Overrides for the busboy limits (count/size caps). Defaults to {@link DEFAULT_LIMITS}. */
  limits?: busboy.Limits
  /** Aggregate buffered-bytes budget across concurrent uploads. Defaults to {@link DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES}. */
  maxInFlightUploadBytes?: number
}

export function multipartParserWrapper<Ctx extends FormDataContext, T extends IHttpServerComponent.IResponse>(
  handler: (ctx: Ctx) => Promise<T>,
  options?: MultipartParserOptions
): (ctx: IHttpServerComponent.DefaultContext) => Promise<T> {
  const maxSizeInBytes = options?.maxSizeInBytes ?? DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
  const maxInFlightUploadBytes = options?.maxInFlightUploadBytes ?? DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES

  return async function (ctx): Promise<T> {
    // Reject obviously-oversized uploads up front, before reading or buffering any of the body.
    // A request that lies about (or omits) Content-Length is still bounded by the streaming
    // guard further down, which stops buffering once totalBytes exceeds maxSizeInBytes.
    const declaredSize = parseInt(ctx.request.headers.get('content-length') || '', 10)
    if (!isNaN(declaredSize) && declaredSize > maxSizeInBytes) {
      throw new InvalidRequestError('The multipart request is too large.')
    }

    // Bound aggregate buffered memory: this parser runs before any auth on POST /entities, so it
    // must self-limit how much it buffers at once. Each request reserves its declared size (capped
    // at the per-request limit; the full limit when no Content-Length is given). Requests that
    // would push the in-flight total over budget are shed with 503 without reading the body. We
    // always admit when nothing else is in flight so a single large upload can still make progress.
    // The reservation is held until the handler completes, since the buffers live for its duration.
    const reservedBytes = isNaN(declaredSize) ? maxSizeInBytes : Math.min(declaredSize, maxSizeInBytes)
    if (inFlightUploadBytes > 0 && inFlightUploadBytes + reservedBytes > maxInFlightUploadBytes) {
      return {
        status: 503,
        headers: { 'Retry-After': '5' },
        body: { error: 'Service Unavailable', message: 'Server is buffering too many uploads, please retry shortly.' }
        // The wrapper is typed to the handler's response type; this shed response is a valid IResponse.
      } as unknown as T
    }
    inFlightUploadBytes += reservedBytes
    try {
      return await parseAndHandle(ctx)
    } finally {
      inFlightUploadBytes -= reservedBytes
    }
  }

  async function parseAndHandle(ctx: IHttpServerComponent.DefaultContext): Promise<T> {
    let formDataParser: busboy.Busboy
    try {
      formDataParser = busboy({
        headers: {
          'content-type': ctx.request.headers.get('content-type') || undefined
        },
        limits: { ...DEFAULT_LIMITS, fileSize: maxSizeInBytes, ...options?.limits }
      })
    } catch (error: any) {
      throw new InvalidRequestError(error.message || 'Invalid multipart form data')
    }

    // Null-prototype maps so an attacker-controlled field/file name such as `__proto__` or
    // `constructor` is stored as a plain key. On a plain object a field named `__proto__` makes
    // `if (fields[name])` read Object.prototype (truthy) and then `fields[name].value.push(...)`
    // throw, aborting the request.
    const fields: FormDataContext['formData']['fields'] = Object.create(null)
    const files: FormDataContext['formData']['files'] = Object.create(null)

    // Uploaded files are streamed to temp files under this directory and removed once the handler
    // returns, so large content files are never held in memory in full.
    const tmpDir = await mkdtemp(join(tmpdir(), 'wcs-upload-'))
    const fileWrites: Promise<void>[] = []
    let fileIndex = 0

    let totalBytes = 0
    let limitError: string | undefined
    // Record the first limit breach; surfaced after parsing finishes. We do NOT destroy the
    // parser here (destroying busboy mid-write corrupts its internal state) — busboy already
    // truncates/caps per its limits, and the handlers below stop writing once over the limit, so
    // disk usage stays bounded while busboy drains and emits 'close'.
    function fail(message: string): void {
      if (!limitError) {
        limitError = message
      }
    }

    formDataParser.on('partsLimit', () => fail('The multipart request has too many parts.'))
    formDataParser.on('filesLimit', () => fail('The multipart request has too many files.'))
    formDataParser.on('fieldsLimit', () => fail('The multipart request has too many fields.'))

    /**
     * Emitted for each new non-file field found.
     * All field values are stored as arrays to support multiple values with the same name.
     */
    formDataParser.on('field', function (name: string, value: string, info: FieldInfo): void {
      totalBytes += Buffer.byteLength(value)
      if (info.valueTruncated || totalBytes > maxSizeInBytes) {
        return fail('The multipart request is too large.')
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
      const filepath = join(tmpDir, String(fileIndex++))
      const writeStream = createWriteStream(filepath)
      let size = 0
      let aborted = false

      stream.on('limit', function () {
        fail('An uploaded file exceeds the maximum allowed size.')
      })

      const written = new Promise<void>((resolve) => {
        const finalize = (): void => {
          files[name] = { ...info, fieldname: name, filepath, size }
          resolve()
        }
        stream.on('data', function (data) {
          totalBytes += data.length
          if (aborted) {
            return
          }
          if (totalBytes > maxSizeInBytes) {
            fail('The multipart request is too large.')
            aborted = true
            writeStream.end()
            return
          }
          size += data.length
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
          finalize()
        })
        writeStream.on('finish', finalize)
        writeStream.on('error', function () {
          if (!aborted) {
            fail('Failed to store an uploaded file.')
            aborted = true
          }
          finalize()
        })
      })
      fileWrites.push(written)
    })

    const newContext: Ctx = Object.assign(Object.create(ctx), { formData: { fields, files } })

    try {
      try {
        // `.pipe()` doesn't propagate teardown: a client disconnecting mid-upload would leave busboy
        // waiting forever (and the temp dir below never cleaned up). `pipeline` tears both streams
        // down if either errors and rejects here instead. busboy is otherwise drained to completion —
        // limit breaches are recorded via fail() and surfaced after parsing, never by destroying it.
        await pipeline(ctx.request.body as Readable, formDataParser)
      } catch (error: any) {
        throw new InvalidRequestError(limitError || error.message || 'Invalid multipart form data')
      }

      // Wait for every temp file to finish flushing before the handler reads them.
      await Promise.all(fileWrites)

      if (limitError) {
        throw new InvalidRequestError(limitError)
      }

      return await handler(newContext)
    } finally {
      // Remove temp files once the handler has finished consuming them (on success or error).
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
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
