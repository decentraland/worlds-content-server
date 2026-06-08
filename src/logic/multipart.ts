// TODO: move this helper to well-known-components

import { InvalidRequestError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import busboy, { FieldInfo, FileInfo } from 'busboy'
import { Readable } from 'stream'

export type FormDataContext = IHttpServerComponent.DefaultContext & {
  formData: {
    fields: Record<
      string,
      FieldInfo & {
        fieldname: string
        value: string[]
      }
    >
    files: Record<
      string,
      FileInfo & {
        fieldname: string
        value: Buffer
      }
    >
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

export type MultipartParserOptions = {
  /** Maximum total bytes (across all files and fields) buffered before the request is rejected. */
  maxSizeInBytes?: number
  /** Overrides for the busboy limits (count/size caps). Defaults to {@link DEFAULT_LIMITS}. */
  limits?: busboy.Limits
}

export function multipartParserWrapper<Ctx extends FormDataContext, T extends IHttpServerComponent.IResponse>(
  handler: (ctx: Ctx) => Promise<T>,
  options?: MultipartParserOptions
): (ctx: IHttpServerComponent.DefaultContext) => Promise<T> {
  const maxSizeInBytes = options?.maxSizeInBytes ?? DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES

  return async function (ctx): Promise<T> {
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

    const fields: FormDataContext['formData']['fields'] = {}
    const files: FormDataContext['formData']['files'] = {}

    let totalBytes = 0
    let limitError: string | undefined
    // Record the first limit breach; surfaced after parsing finishes. We do NOT destroy the
    // parser here (destroying busboy mid-write corrupts its internal state) — busboy already
    // truncates/caps per its limits, and the data handlers below stop buffering once over the
    // limit, so memory stays bounded while busboy drains and emits 'close'.
    function fail(message: string): void {
      if (!limitError) {
        limitError = message
      }
    }

    const finished = new Promise((ok, err) => {
      formDataParser.on('error', err)
      formDataParser.on('close', ok)
    })

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
      const chunks: any[] = []
      stream.on('limit', function () {
        fail('An uploaded file exceeds the maximum allowed size.')
      })
      stream.on('data', function (data) {
        totalBytes += data.length
        if (totalBytes > maxSizeInBytes) {
          fail('The multipart request is too large.')
          return
        }
        chunks.push(data)
      })
      stream.on('error', function () {
        stream.resume()
      })
      stream.on('end', function () {
        files[name] = {
          ...info,
          fieldname: name,
          value: Buffer.concat(chunks)
        }
      })
    })

    ctx.request.body.pipe(formDataParser)

    const newContext: Ctx = Object.assign(Object.create(ctx), { formData: { fields, files } })

    try {
      await finished
    } catch (error: any) {
      throw new InvalidRequestError(limitError || error.message || 'Invalid multipart form data')
    }

    if (limitError) {
      throw new InvalidRequestError(limitError)
    }

    return handler(newContext)
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
