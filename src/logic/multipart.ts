// TODO: move this helper to well-known-components

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

export function multipartParserWrapper<Ctx extends FormDataContext, T extends IHttpServerComponent.IResponse>(
  handler: (ctx: Ctx) => Promise<T>
): (ctx: IHttpServerComponent.DefaultContext) => Promise<T> {
  return async function (ctx): Promise<T> {
    const formDataParser = busboy({
      headers: {
        'content-type': ctx.request.headers.get('content-type') || undefined
      }
    })

    const fields: FormDataContext['formData']['fields'] = {}
    const files: FormDataContext['formData']['files'] = {}

    const finished = new Promise((ok, err) => {
      formDataParser.on('error', err)
      formDataParser.on('finish', ok)
    })

    /**
     * Emitted for each new non-file field found.
     * All field values are stored as arrays to support multiple values with the same name.
     */
    formDataParser.on('field', function (name: string, value: string, info: FieldInfo): void {
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
      stream.on('data', function (data) {
        chunks.push(data)
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

    await finished

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
