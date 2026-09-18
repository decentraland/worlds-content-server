import { HandlerContextWithPath, WorldSettings, WorldSettingsInput } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from '../../logic/settings'
import { FormDataContext, isDefinedMultipartField, readUploadedFile } from '../../logic/multipart'
import { IWorldSettingsPolicyComponent } from '../../logic/world-settings-policy'
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
  settingsPolicy: IWorldSettingsPolicyComponent,
  thumbnails: IThumbnailsComponent
): Promise<WorldSettingsInput> {
  const { fields, files } = formData
  const input: WorldSettingsInput = {}

  if (fields.title?.value?.length > 0) {
    const titleValue = fields.title.value[0]
    const { min, max } = settingsPolicy.titleLength
    if (settingsPolicy.toStorableTitle(titleValue) === null) {
      throw new ValidationError(
        titleValue.length === 0
          ? `Invalid title: title cannot be empty. Expected between ${min} and ${max} characters.`
          : `Invalid title: ${titleValue}. Expected between ${min} and ${max} characters.`
      )
    }
    input.title = titleValue
  }

  if (fields.description?.value?.length > 0) {
    const descriptionValue = fields.description.value[0]
    const { min, max } = settingsPolicy.descriptionLength
    if (settingsPolicy.toStorableDescription(descriptionValue) === null) {
      throw new ValidationError(
        descriptionValue.length === 0
          ? `Invalid description: description cannot be empty. Expected between ${min} and ${max} characters.`
          : `Invalid description: ${descriptionValue}. Expected between ${min} and ${max} characters.`
      )
    }
    input.description = descriptionValue
  }

  if (isDefinedMultipartField(fields.content_rating)) {
    if (!settingsPolicy.isValidContentRating(fields.content_rating.value[0])) {
      throw new ValidationError(
        `Invalid content rating: ${fields.content_rating.value[0]}. Expected one of: ${settingsPolicy.contentRatings.join(', ')}`
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
    if (value === 'null') {
      // An explicit null clears the fixed skybox
      input.skyboxTime = null
    } else {
      // Number, not parseInt: the latter accepts trailing garbage and floors fractions, so "12abc"
      // and "1.5" used to be stored silently as 12 and 1, and unstorable values reached PostgreSQL
      // as a 500 instead of being refused here.
      const parsed = settingsPolicy.toStorableSkyboxTime(Number(value))
      if (parsed === null) {
        const { min, max } = settingsPolicy.skyboxTimeRange
        throw new ValidationError(
          `Invalid skybox_time: ${value}. Expected an integer between ${min} and ${max}, or null.`
        )
      }
      input.skyboxTime = parsed
    }
  }

  if (isDefinedMultipartField(fields.categories)) {
    if (fields.categories.value.length === 1 && fields.categories.value[0] === 'null') {
      input.categories = []
    } else {
      if (fields.categories.value.length > settingsPolicy.maxCategories) {
        throw new ValidationError(
          `Invalid categories: ${fields.categories.value.length} items. Expected at most ${settingsPolicy.maxCategories}`
        )
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
    'coordinates' | 'namePermissionChecker' | 'settings' | 'settingsPolicy' | 'thumbnails' | 'worldsManager',
    '/world/:world_name/settings'
  > &
    DecentralandSignatureContext<any> &
    FormDataContext
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const { coordinates, settings, settingsPolicy, thumbnails } = ctx.components
  const signer = ctx.verification!.auth

  try {
    const input = await parseMultipartInput(ctx.formData, coordinates, settingsPolicy, thumbnails)
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
