import { IHttpServerComponent } from '@well-known-components/interfaces'
import { IPFSv2 } from '@dcl/schemas'
import { HandlerContextWithPath } from '../../types'
import { ContentItem } from '@dcl/catalyst-storage'
import { fromStream } from 'file-type'
import { Readable } from 'stream'

async function contentItemHeaders(content: ContentItem, hashId: string) {
  const stream: Readable = await content.asRawStream()
  const mime = await fromStream(stream)
  const mimeType = mime?.mime || 'application/octet-stream'

  const ret: Record<string, string> = {
    'Content-Type': mimeType,
    ETag: JSON.stringify(hashId), // by spec, the ETag must be a double-quoted string
    'Access-Control-Expose-Headers': 'ETag',
    'Cache-Control': 'public,max-age=31536000,s-maxage=31536000,immutable'
  }
  if (content.encoding) {
    ret['Content-Encoding'] = content.encoding
  }
  if (content.size) {
    ret['Content-Length'] = content.size.toString()
  }
  return ret
}

export async function getContentFile(
  ctx: HandlerContextWithPath<'storage' | 'logs', '/contents/:hashId'>
): Promise<IHttpServerComponent.IResponse> {
  if (!IPFSv2.validate(ctx.params.hashId)) return { status: 400 }
  const { storage, logs } = ctx.components
  const logger = logs.getLogger('http-server')
  const file = await storage.retrieve(ctx.params.hashId)
  if (!file) {
    return {
      status: 404,
      body: `File with hash ${ctx.params.hashId} not found`
    }
  }

  const headers = await contentItemHeaders(file, ctx.params.hashId)
  logger.info('file: ' + ctx.params.hashId + ' Content-Type: ' + headers['Content-Type'])

  if (!file) return { status: 404 }

  return { status: 200, headers: headers, body: await file.asRawStream() }
}

export async function headContentFile(
  ctx: HandlerContextWithPath<'storage', '/contents/:hashId'>
): Promise<IHttpServerComponent.IResponse> {
  if (!IPFSv2.validate(ctx.params.hashId)) return { status: 400 }

  const file = await ctx.components.storage.retrieve(ctx.params.hashId)

  if (!file) return { status: 404 }

  return { status: 200, headers: await contentItemHeaders(file, ctx.params.hashId) }
}

export async function availableContentHandler(
  ctx: HandlerContextWithPath<'storage', '/content/available-content'>
): Promise<IHttpServerComponent.IResponse> {
  const params = new URLSearchParams(ctx.url.search)
  const cids = params.getAll('cid')

  const results = Array.from((await ctx.components.storage.existMultiple(cids)).entries())

  return {
    status: 200,
    body: results.map(([cid, available]) => ({
      cid,
      available
    }))
  }
}
