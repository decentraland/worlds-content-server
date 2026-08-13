/** Longest magic-byte signature checked below (RIFF....WEBP). */
export const THUMBNAIL_SIGNATURE_BYTES = 12

/**
 * Identifies a thumbnail's format by its leading magic bytes.
 *
 * Thumbnails are stored and later served verbatim, so anything that is not a real raster image
 * (e.g. HTML/SVG/scripts smuggled as a "thumbnail") must be rejected. Shared by the settings
 * endpoint, which validates uploads, and the deploy path, which promotes a scene's navmapThumbnail.
 *
 * @param buffer - Leading bytes of the candidate image (at least THUMBNAIL_SIGNATURE_BYTES)
 * @returns The detected format, or null when the bytes are not a supported image
 */
export function detectImageFormat(buffer: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
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
