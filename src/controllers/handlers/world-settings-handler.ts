import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from '../../logic/settings'
import { WorldSettingsInput } from '../schemas/world-settings-schemas'

export async function getWorldSettingsHandler(
  ctx: HandlerContextWithPath<'settings', '/world/:world_name/settings'>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const { settings } = ctx.components

  try {
    const worldSettings = await settings.getWorldSettings(world_name)

    return {
      status: 200,
      body: worldSettings
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
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const { settings } = ctx.components
  const signer = ctx.verification!.auth

  try {
    const body = (await ctx.request.json()) as WorldSettingsInput
    const updatedSettings = await settings.updateWorldSettings(world_name, signer, {
      spawnCoordinates: body.spawn_coordinates
    })

    return {
      status: 200,
      body: { message: 'World settings updated successfully', settings: updatedSettings }
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
