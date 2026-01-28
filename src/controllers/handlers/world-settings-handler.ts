import { HandlerContextWithPath, WorldSettings, WorldSettingsInput } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from '../../logic/settings'
import { FormDataContext, isDefinedMultipartField } from '../../logic/multipart'
import { ICoordinatesComponent } from '../../logic/coordinates'

type SnakeCaseWorldSettings = {
  title?: string
  description?: string
  content_rating?: string
  spawn_coordinates?: string
  skybox_time?: number | null
  categories?: string[]
  single_player?: boolean
  show_in_places?: boolean
  thumbnail_hash?: string
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

function parseMultipartInput(
  formData: FormDataContext['formData'],
  coordinates: ICoordinatesComponent
): WorldSettingsInput {
  const { fields, files } = formData
  const input: WorldSettingsInput = {}

  if (isDefinedMultipartField(fields.title)) {
    if (fields.title.value[0].length < 3 || fields.title.value[0].length > 100) {
      throw new ValidationError(`Invalid title: ${fields.title.value[0]}. Expected between 3 and 100 characters.`)
    }
    input.title = fields.title.value[0]
  }

  if (isDefinedMultipartField(fields.description)) {
    if (fields.description.value[0].length < 3 || fields.description.value[0].length > 1000) {
      throw new ValidationError(
        `Invalid description: ${fields.description.value[0]}. Expected between 3 and 1000 characters.`
      )
    }
    input.description = fields.description.value[0]
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
    if (fields.categories.value.length > 20) {
      throw new ValidationError(`Invalid categories: ${fields.categories.value.length} items. Expected at most 20`)
    }
    input.categories = fields.categories.value
  }

  if (isDefinedMultipartField(fields.single_player)) {
    input.singlePlayer = fields.single_player.value[0] === 'true'
  }

  if (isDefinedMultipartField(fields.show_in_places)) {
    input.showInPlaces = fields.show_in_places.value[0] === 'true'
  }

  // Handle thumbnail file
  if (files.thumbnail?.value) {
    const maxThumbnailSize = 1024 * 1024 // 1MB
    if (files.thumbnail.value.length > maxThumbnailSize) {
      throw new ValidationError(
        `Invalid thumbnail: size ${files.thumbnail.value.length} bytes exceeds maximum of ${maxThumbnailSize} bytes (1MB).`
      )
    }
    input.thumbnail = files.thumbnail.value
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
    const input = parseMultipartInput(ctx.formData, coordinates)
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
