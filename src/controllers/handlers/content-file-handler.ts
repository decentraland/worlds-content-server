import { IHttpServerComponent } from '@dcl/core-commons'
import { IPFSv2 } from '@dcl/schemas'
import { HandlerContextWithPath } from '../../types'
import { ContentItem, IContentStorageComponent } from '@dcl/catalyst-storage'
import { InvalidRequestError } from '@dcl/http-commons'
import { fromStream } from 'file-type'
import { Readable } from 'stream'

const EXPOSED_HEADERS = 'ETag, Accept-Ranges, Content-Range'
export const MAX_AVAILABLE_CONTENT_CIDS = 500

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

// file-type inspects magic bytes near the start of the file; 4100 bytes is its internal sample
// size and is enough to recognize every format it supports.
const MIME_SNIFF_BYTES = 4100

// Content is addressed by hash, so the request carries no file name or extension to derive a MIME
// type from. We detect it by sniffing the file's magic bytes. The detected type describes the full
// representation, so it is also correct for partial (206) responses. Anything file-type cannot
// recognize (plain text, JSON, glTF, ...) falls back to application/octet-stream.
//
// We sniff the raw stream: worlds content is always stored uncompressed (deploys use storeStream,
// never storeStreamAndCompress), so the raw bytes are the real bytes. We skip detection for any
// compressed item rather than route it through asStream(), which would pipe the source into a
// gunzip transform whose source stream destroy() does not tear down (an fd/socket leak).
async function detectContentType(item: ContentItem): Promise<string> {
  if (item.encoding) return DEFAULT_CONTENT_TYPE

  let stream: Readable | undefined
  try {
    stream = await item.asRawStream()
    const result = await fromStream(stream)
    return result?.mime ?? DEFAULT_CONTENT_TYPE
  } catch {
    return DEFAULT_CONTENT_TYPE
  } finally {
    // We only need the head of the file; destroying the stream aborts any remaining transfer.
    stream?.destroy()
  }
}

// Content is addressed by IPFS CIDv1, but world thumbnails have historically been stored under a
// raw SHA-256 hex digest. Accept both when serving so those legacy thumbnails remain retrievable.
// Both formats are strictly validated and contain no path separators, so neither can escape the
// storage root.
const SHA256_HEX = /^[0-9a-f]{64}$/

function isRetrievableContentKey(hashId: string): boolean {
  return IPFSv2.validate(hashId) || SHA256_HEX.test(hashId)
}

function contentItemHeaders(content: ContentItem, hashId: string, contentType: string) {
  const ret: Record<string, string> = {
    'Content-Type': contentType,
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
  const contentType = await detectContentType(file)
  return { status: 200, headers: contentItemHeaders(file, hashId, contentType), body: await file.asRawStream() }
}

export async function getContentFile(
  ctx: HandlerContextWithPath<'storage', '/contents/:hashId'>
): Promise<IHttpServerComponent.IResponse> {
  if (!isRetrievableContentKey(ctx.params.hashId)) return { status: 400 }

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

  // start and end are inclusive byte offsets, matching RFC 7233 and catalyst-storage convention.
  // retrieve may throw RangeError if the file size changed between fileInfo and retrieve.
  let file: Awaited<ReturnType<IContentStorageComponent['retrieve']>>
  try {
    file = await ctx.components.storage.retrieve(ctx.params.hashId, { start: range.start, end: range.end })
  } catch (error) {
    if (error instanceof RangeError) {
      return {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileInfo.size}`
        }
      }
    }
    throw error
  }
  if (!file) return { status: 404 }

  // Sniff the MIME type from the start of the file, not the requested range (which may begin
  // mid-file). encoding is null here (compressed content bailed out above), so a small read from
  // offset 0 yields valid bytes to inspect.
  const head = await ctx.components.storage.retrieve(ctx.params.hashId, {
    start: 0,
    end: Math.min(MIME_SNIFF_BYTES - 1, fileInfo.size - 1)
  })
  const contentType = head ? await detectContentType(head) : DEFAULT_CONTENT_TYPE

  return {
    status: 206,
    headers: {
      ...contentItemHeaders(file, ctx.params.hashId, contentType),
      'Content-Length': (range.end - range.start + 1).toString(),
      'Content-Range': `bytes ${range.start}-${range.end}/${fileInfo.size}`
    },
    body: await file.asRawStream()
  }
}

export async function headContentFile(
  ctx: HandlerContextWithPath<'storage', '/contents/:hashId'>
): Promise<IHttpServerComponent.IResponse> {
  if (!isRetrievableContentKey(ctx.params.hashId)) return { status: 400 }

  const file = await ctx.components.storage.retrieve(ctx.params.hashId)

  if (!file) return { status: 404 }

  const contentType = await detectContentType(file)
  return { status: 200, headers: contentItemHeaders(file, ctx.params.hashId, contentType) }
}

export async function availableContentHandler(
  ctx: HandlerContextWithPath<'storage', '/content/available-content'>
): Promise<IHttpServerComponent.IResponse> {
  const params = new URLSearchParams(ctx.url.search)
  const cids = params.getAll('cid')

  if (cids.length === 0) {
    throw new InvalidRequestError('At least one cid query parameter is required.')
  }

  if (cids.length > MAX_AVAILABLE_CONTENT_CIDS) {
    throw new InvalidRequestError(`Too many cid query parameters. Maximum allowed is ${MAX_AVAILABLE_CONTENT_CIDS}.`)
  }

  for (const cid of cids) {
    if (!IPFSv2.validate(cid)) {
      throw new InvalidRequestError('Invalid cid format.')
    }
  }

  const results = Array.from((await ctx.components.storage.existMultiple(cids)).entries())

  return {
    status: 200,
    body: results.map(([cid, available]) => ({
      cid,
      available
    }))
  }
}
