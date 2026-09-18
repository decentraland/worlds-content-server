export type ThumbnailFormat = 'png' | 'jpeg' | 'gif' | 'webp'

export type IThumbnailsComponent = {
  /**
   * Identifies a thumbnail's format from its leading magic bytes.
   *
   * Thumbnails are stored and later served verbatim, so anything that is not a real raster image
   * (e.g. HTML/SVG/scripts smuggled as a "thumbnail") has to be rejected.
   *
   * @param buffer - Leading bytes of the candidate image
   * @returns The detected format, or null when the bytes are not a supported image
   */
  detectFormat(buffer: Buffer): ThumbnailFormat | null

  /**
   * Decides whether a scene's thumbnail hash may be promoted into the world settings, by checking
   * the stored bytes against the formats an uploaded thumbnail must satisfy.
   *
   * @param hash - Content hash the scene's navmapThumbnail resolves to
   * @returns The hash when it points at a supported image, null when it does not or cannot be read
   */
  resolveStorableHash(hash: string): Promise<string | null>
}
