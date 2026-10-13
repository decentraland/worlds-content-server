import { IHttpServerComponent } from '@dcl/core-commons'
import { FieldInfo, FileInfo } from 'busboy'
import { createReadStream } from 'fs'
import { readFile } from 'fs/promises'
import { Readable } from 'stream'
import { hashV1 } from '@dcl/hashing'
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

function createDeploymentFileStream(filepath: string, signal?: AbortSignal): Readable {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Deployment file read was aborted.')
  }
  const stream = createReadStream(filepath)
  if (signal) {
    const abort = (): void => {
      stream.destroy(signal.reason ?? new Error('Deployment file read was aborted.'))
    }
    signal.addEventListener('abort', abort, { once: true })
    stream.once('close', () => signal.removeEventListener('abort', abort))
  }
  return stream
}

/**
 * Wraps an uploaded file as a {@link DeploymentFile}, memoizing the full-buffer read and the hash.
 *
 * Memoization assumes every call shares the single request-scoped signal: the first caller's
 * signal is baked into the memoized promise, and an aborted first read stays rejected for later
 * callers. Both are correct while the file never outlives its request.
 */
export function toDeploymentFile(file: UploadedFile): DeploymentFile {
  let buffered: Promise<Buffer> | undefined
  let hash: Promise<string> | undefined
  return {
    size: file.size,
    getStream: (signal) => createDeploymentFileStream(file.filepath, signal),
    getHash: (signal) =>
      (hash ??= buffered
        ? buffered.then((content) => hashV1(content))
        : hashV1(createDeploymentFileStream(file.filepath, signal))),
    isHashed: () => hash !== undefined,
    asBuffer: (signal) => (buffered ??= readFile(file.filepath, signal ? { signal } : undefined))
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
