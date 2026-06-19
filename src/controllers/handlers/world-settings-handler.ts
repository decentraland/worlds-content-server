import { HandlerContextWithPath, WorldSettings, WorldSettingsInput } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from '../../logic/settings'
import { FormDataContext, isDefinedMultipartField, readUploadedFile } from '../../logic/multipart'
import { ICoordinatesComponent } from '../../logic/coordinates'

type SnakeCaseWorldSettings = {
  title?: string
  description?: string
  content_rating?: string
  spawn_coordinates?: string
  skybox_time?: number | null
  categories?: string[] | null
  single_player?: boolean
  show_in_places?: boolean
  thumbnail_hash?: string
}

// Allowed thumbnail image formats, identified by their leading magic bytes. The thumbnail is
// stored and later served verbatim, so we reject anything that is not a real raster image
// (e.g. HTML/SVG/scripts smuggled as a "thumbnail").
function detectImageFormat(buffer: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
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

function toSnakeCaseSettings(settings: WorldSettings): SnakeCaseWorldSettings {
  return {
    title: settings.title,
    description: settings.description,
    content_rating: settings.contentRating,
    spawn_coordinates: settings.spawnCoordinates,
    skybox_time: settings.skyboxTime,
    categories: settings.categories,
    single_player: settings.singlePlayer,
    show_in_places: settings.showInPlaces,
    thumbnail_hash: settings.thumbnailHash
  }
}

async function parseMultipartInput(
  formData: FormDataContext['formData'],
  coordinates: ICoordinatesComponent
): Promise<WorldSettingsInput> {
  const { fields, files } = formData
  const input: WorldSettingsInput = {}

  if (fields.title?.value?.length > 0) {
    const titleValue = fields.title.value[0]
    if (titleValue.length < 3 || titleValue.length > 100) {
      throw new ValidationError(
        titleValue.length === 0
          ? 'Invalid title: title cannot be empty. Expected between 3 and 100 characters.'
          : `Invalid title: ${titleValue}. Expected between 3 and 100 characters.`
      )
    }
    input.title = titleValue
  }

  if (fields.description?.value?.length > 0) {
    const descriptionValue = fields.description.value[0]
    if (descriptionValue.length < 3 || descriptionValue.length > 1000) {
      throw new ValidationError(
        descriptionValue.length === 0
          ? 'Invalid description: description cannot be empty. Expected between 3 and 1000 characters.'
          : `Invalid description: ${descriptionValue}. Expected between 3 and 1000 characters.`
      )
    }
    input.description = descriptionValue
  }

  if (isDefinedMultipartField(fields.content_rating)) {
    const validRatings = ['RP', 'E', 'T', 'A', 'R']
    if (!validRatings.includes(fields.content_rating.value[0])) {
      throw new ValidationError(
        `Invalid content rating: ${fields.content_rating.value[0]}. Expected one of: ${validRatings.join(', ')}`
      )
    }
    input.contentRating = fields.content_rating.value[0]
  }

  if (isDefinedMultipartField(fields.spawn_coordinates)) {
    const spawnCoordinatesValue = fields.spawn_coordinates.value[0]
    // Validate format using coordinates component
    try {
      coordinates.parseCoordinate(spawnCoordinatesValue)
    } catch (error) {
      throw new ValidationError(`Invalid spawnCoordinates format: "${spawnCoordinatesValue}".`)
    }
    input.spawnCoordinates = spawnCoordinatesValue
  }

  if (isDefinedMultipartField(fields.skybox_time)) {
    const value = fields.skybox_time.value[0]
    // Validate that skybox is either null or a valid number
    input.skyboxTime = value === 'null' ? null : parseInt(value)
  }

  if (isDefinedMultipartField(fields.categories)) {
    if (fields.categories.value.length === 1 && fields.categories.value[0] === 'null') {
      input.categories = []
    } else {
      if (fields.categories.value.length > 20) {
        throw new ValidationError(`Invalid categories: ${fields.categories.value.length} items. Expected at most 20`)
      }
      input.categories = fields.categories.value
    }
  }

  if (isDefinedMultipartField(fields.single_player)) {
    input.singlePlayer = fields.single_player.value[0] === 'true'
  }

  if (isDefinedMultipartField(fields.show_in_places)) {
    input.showInPlaces = fields.show_in_places.value[0] === 'true'
  }

  // Handle thumbnail file
  if (files.thumbnail) {
    const maxThumbnailSize = 1024 * 1024 // 1MB
    if (files.thumbnail.size > maxThumbnailSize) {
      throw new ValidationError(
        `Invalid thumbnail: size ${files.thumbnail.size} bytes exceeds maximum of ${maxThumbnailSize} bytes (1MB).`
      )
    }
    // Thumbnails are capped at 1MB, so reading the temp file fully into memory is fine.
    const thumbnail = await readUploadedFile(files.thumbnail)
    if (!detectImageFormat(thumbnail)) {
      throw new ValidationError('Invalid thumbnail: expected a PNG, JPEG, GIF or WebP image.')
    }
    input.thumbnail = thumbnail
  }

  return input
}

export async function getWorldSettingsHandler(
  ctx: HandlerContextWithPath<'settings', '/world/:world_name/settings'>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const { settings } = ctx.components

  try {
    const worldSettings = await settings.getWorldSettings(world_name)

    return {
      status: 200,
      body: toSnakeCaseSettings(worldSettings)
    }
  } catch (error) {
    if (error instanceof WorldNotFoundError) {
      return {
        status: 404,
        body: { error: error.message }
      }
    }

    throw error
  }
}

export async function updateWorldSettingsHandler(
  ctx: HandlerContextWithPath<
    'coordinates' | 'namePermissionChecker' | 'worldsManager' | 'settings',
    '/world/:world_name/settings'
  > &
    DecentralandSignatureContext<any> &
    FormDataContext
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const { coordinates, settings } = ctx.components
  const signer = ctx.verification!.auth

  try {
    const input = await parseMultipartInput(ctx.formData, coordinates)
    const updatedSettings = await settings.updateWorldSettings(world_name, signer, input)

    return {
      status: 200,
      body: { message: 'World settings updated successfully', settings: toSnakeCaseSettings(updatedSettings) }
    }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        status: 403,
        body: { error: error.message }
      }
    }

    if (error instanceof ValidationError) {
      return {
        status: 400,
        body: { error: error.message }
      }
    }

    throw error
  }
}
