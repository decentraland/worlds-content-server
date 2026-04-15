import { IHttpServerComponent } from '@well-known-components/interfaces'
import { IPFSv2 } from '@dcl/schemas'
import { HandlerContextWithPath } from '../../types'
import { ContentItem, IContentStorageComponent } from '@dcl/catalyst-storage'

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
  if (content.size !== null) {
    ret['Content-Length'] = content.size.toString()
  }
  return ret
}

export type RangeParseResult =
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'unsupported' }
  | { kind: 'invalid' }

/**
 * Parses a Range header value against a known file size.
 * Supports:
 *   bytes=START-END
 *   bytes=START-
 *   bytes=-SUFFIX
 * Returns { kind: 'unsupported' } for formats we don't handle (e.g. multi-range, non-bytes unit).
 * Returns { kind: 'invalid' } for syntactically valid but unsatisfiable ranges.
 */
export function parseRangeHeader(header: string, fileSize: number): RangeParseResult {
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return { kind: 'unsupported' }

  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''

  if (!hasStart && !hasEnd) return { kind: 'unsupported' }

  let start: number
  let end: number

  if (!hasStart) {
    // suffix range: bytes=-N (last N bytes)
    const suffix = parseInt(match[2], 10)
    if (suffix === 0) return { kind: 'invalid' }
    start = Math.max(0, fileSize - suffix)
    end = fileSize - 1
  } else {
    start = parseInt(match[1], 10)
    end = hasEnd ? parseInt(match[2], 10) : fileSize - 1
  }

  if (start >= fileSize || end < start) return { kind: 'invalid' }

  return { kind: 'ok', start, end: Math.min(end, fileSize - 1) }
}

async function retrieveFullContent(
  storage: Pick<IContentStorageComponent, 'retrieve'>,
  hashId: string
): Promise<IHttpServerComponent.IResponse> {
  const file = await storage.retrieve(hashId)
  if (!file) return { status: 404 }
  return { status: 200, headers: contentItemHeaders(file, hashId), body: await file.asRawStream() }
}

export async function getContentFile(
  ctx: HandlerContextWithPath<'storage', '/contents/:hashId'>
): Promise<IHttpServerComponent.IResponse> {
  if (!IPFSv2.validate(ctx.params.hashId)) return { status: 400 }

  const rangeHeader = ctx.request.headers.get('range')

  if (!rangeHeader) {
    return retrieveFullContent(ctx.components.storage, ctx.params.hashId)
  }

  const fileInfo = await ctx.components.storage.fileInfo(ctx.params.hashId)
  if (!fileInfo) return { status: 404 }

  // Cannot serve byte ranges on compressed content or when size is unknown
  if (fileInfo.encoding || fileInfo.size === null) {
    return retrieveFullContent(ctx.components.storage, ctx.params.hashId)
  }

  const range = parseRangeHeader(rangeHeader, fileInfo.size)

  if (range.kind === 'invalid') {
    return {
      status: 416,
      headers: {
        'Content-Range': `bytes */${fileInfo.size}`
      }
    }
  }

  // Unsupported range format (e.g. multi-range): ignore and serve full content per RFC 7233
  if (range.kind === 'unsupported') {
    return retrieveFullContent(ctx.components.storage, ctx.params.hashId)
  }

  const file = await ctx.components.storage.retrieve(ctx.params.hashId, { start: range.start, end: range.end })
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
