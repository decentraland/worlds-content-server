import { IHttpServerComponent } from '@well-known-components/interfaces'
import { IPFSv2 } from '@dcl/schemas'
import { HandlerContextWithPath } from '../../types'
import { ContentItem } from '@dcl/catalyst-storage'

const EXPOSED_HEADERS = 'ETag, Accept-Ranges, Content-Range'

function contentItemHeaders(content: ContentItem, hashId: string) {
  const ret: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    ETag: JSON.stringify(hashId), // by spec, the ETag must be a double-quoted string
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Cache-Control': 'public,max-age=31536000,s-maxage=31536000,immutable'
  }
  if (content.encoding) {
    ret['Content-Encoding'] = content.encoding
  } else {
    ret['Accept-Ranges'] = 'bytes'
  }
  if (content.size) {
    ret['Content-Length'] = content.size.toString()
  }
  return ret
}

/**
 * Parses a Range header value against a known file size.
 * Supports:
 *   bytes=START-END
 *   bytes=START-
 *   bytes=-SUFFIX
 * Returns null for unsupported formats (e.g. multi-range).
 */
export function parseRangeHeader(header: string, fileSize: number): { start: number; end: number } | null {
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null

  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''

  if (!hasStart && !hasEnd) return null

  let start: number
  let end: number

  if (!hasStart) {
    // suffix range: bytes=-N (last N bytes)
    const suffix = parseInt(match[2], 10)
    if (suffix === 0) return null
    start = Math.max(0, fileSize - suffix)
    end = fileSize - 1
  } else {
    start = parseInt(match[1], 10)
    end = hasEnd ? parseInt(match[2], 10) : fileSize - 1
  }

  if (start >= fileSize || end < start) return null

  return { start, end: Math.min(end, fileSize - 1) }
}

export async function getContentFile(
  ctx: HandlerContextWithPath<'storage', '/contents/:hashId'>
): Promise<IHttpServerComponent.IResponse> {
  if (!IPFSv2.validate(ctx.params.hashId)) return { status: 400 }

  const rangeHeader = ctx.request.headers.get('range')

  if (rangeHeader) {
    const fileInfo = await ctx.components.storage.fileInfo(ctx.params.hashId)
    if (!fileInfo) return { status: 404 }

    // Cannot serve byte ranges on compressed content
    if (fileInfo.encoding || fileInfo.size === null) {
      const file = await ctx.components.storage.retrieve(ctx.params.hashId)
      if (!file) return { status: 404 }
      return { status: 200, headers: contentItemHeaders(file, ctx.params.hashId), body: await file.asRawStream() }
    }

    const range = parseRangeHeader(rangeHeader, fileInfo.size)
    if (!range) {
      return {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileInfo.size}`
        }
      }
    }

    const file = await ctx.components.storage.retrieve(ctx.params.hashId, range)
    if (!file) return { status: 404 }

    const contentLength = range.end - range.start + 1
    return {
      status: 206,
      headers: {
        'Content-Type': 'application/octet-stream',
        ETag: JSON.stringify(ctx.params.hashId),
        'Access-Control-Expose-Headers': EXPOSED_HEADERS,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public,max-age=31536000,s-maxage=31536000,immutable',
        'Content-Length': contentLength.toString(),
        'Content-Range': `bytes ${range.start}-${range.end}/${fileInfo.size}`
      },
      body: await file.asRawStream()
    }
  }

  const file = await ctx.components.storage.retrieve(ctx.params.hashId)

  if (!file) return { status: 404 }

  return { status: 200, headers: contentItemHeaders(file, ctx.params.hashId), body: await file.asRawStream() }
}

export async function headContentFile(
  ctx: HandlerContextWithPath<'storage', '/contents/:hashId'>
): Promise<IHttpServerComponent.IResponse> {
  if (!IPFSv2.validate(ctx.params.hashId)) return { status: 400 }

  const file = await ctx.components.storage.retrieve(ctx.params.hashId)

  if (!file) return { status: 404 }

  return { status: 200, headers: contentItemHeaders(file, ctx.params.hashId) }
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
