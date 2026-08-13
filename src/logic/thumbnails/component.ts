import { AppComponents } from '../../types'
import { IThumbnailsComponent, ThumbnailFormat } from './types'

/** Longest magic-byte signature checked below (RIFF....WEBP). */
const SIGNATURE_BYTES = 12

/** Reads at most `byteCount` bytes from a stream and stops consuming it. */
async function readStreamPrefix(stream: AsyncIterable<Uint8Array>, byteCount: number): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let collected = 0

  for await (const chunk of stream) {
    chunks.push(chunk)
    collected += chunk.byteLength
    if (collected >= byteCount) {
      break
    }
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, byteCount)
}

/**
 * Creates the component that decides which thumbnails a world may store.
 *
 * Owns both halves of that decision — the accepted image formats and whether a scene's thumbnail may
 * be promoted into the world settings — so an uploaded thumbnail and a deploy-derived one are held to
 * the same contract.
 *
 * @param components - Storage to read candidate thumbnails from, and logs
 * @returns The thumbnails component
 */
export async function createThumbnailsComponent({
  logs,
  storage
}: Pick<AppComponents, 'logs' | 'storage'>): Promise<IThumbnailsComponent> {
  const logger = logs.getLogger('thumbnails')

  function detectFormat(buffer: Buffer): ThumbnailFormat | null {
    if (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'png'
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'jpeg'
    }
    // GIF87a / GIF89a (full 6-byte signature, so e.g. "GIF8XX" does not pass)
    if (
      buffer.length >= 6 &&
      (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a')
    ) {
      return 'gif'
    }
    // RIFF....WEBP
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP'
    ) {
      return 'webp'
    }
    return null
  }

  async function resolveStorableHash(hash: string): Promise<string | null> {
    try {
      const content = await storage.retrieve(hash)
      if (!content) {
        return null
      }

      const signature = await readStreamPrefix(await content.asStream(), SIGNATURE_BYTES)
      if (detectFormat(signature)) {
        return hash
      }

      logger.info('Ignoring scene thumbnail that is not a supported image', { hash })
      return null
    } catch (error) {
      // An unreadable thumbnail must not fail an otherwise valid deployment
      logger.warn('Could not verify the scene thumbnail; storing the world without it', {
        hash,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  return {
    detectFormat,
    resolveStorableHash
  }
}
