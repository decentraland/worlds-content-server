import { HandlerContextWithPath, WorldSettings, WorldSettingsInput } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from '../../logic/settings'
import { FormDataContext, isDefinedMultipartField, readUploadedFile } from '../../logic/multipart'
import { IContentRatingComponent } from '../../logic/content-rating'
import { ICoordinatesComponent } from '../../logic/coordinates'
import { IThumbnailsComponent } from '../../logic/thumbnails'

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
  access_type?: string
  settings_version?: number
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
    thumbnail_hash: settings.thumbnailHash,
    access_type: settings.accessType,
    settings_version: settings.settingsVersion
  }
}

async function parseMultipartInput(
  formData: FormDataContext['formData'],
  coordinates: ICoordinatesComponent,
  contentRating: IContentRatingComponent,
  thumbnails: IThumbnailsComponent
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
    if (!contentRating.isValid(fields.content_rating.value[0])) {
      throw new ValidationError(
        `Invalid content rating: ${fields.content_rating.value[0]}. Expected one of: ${contentRating.supported.join(', ')}`
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
    if (!thumbnails.detectFormat(thumbnail)) {
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
    'contentRating' | 'coordinates' | 'namePermissionChecker' | 'settings' | 'thumbnails' | 'worldsManager',
    '/world/:world_name/settings'
  > &
    DecentralandSignatureContext<any> &
    FormDataContext
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const { contentRating, coordinates, settings, thumbnails } = ctx.components
  const signer = ctx.verification!.auth

  try {
    const input = await parseMultipartInput(ctx.formData, coordinates, contentRating, thumbnails)
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
