import { IHttpServerComponent } from '@dcl/core-commons'
import { InvalidRequestError, NotFoundError } from '@dcl/http-commons'
import { HandlerContextWithPath } from '../../types'
import { WorldOwnerNotFoundError } from '../../adapters/limits-manager'
import { validateParcels } from '../../logic/validations/parcels'

/**
 * Returns the scene limits a deployment to the world is checked against.
 * Parcels are canonicalized and deduplicated exactly as the size validation does.
 */
export async function getWorldLimitsHandler(
  ctx: Pick<
    HandlerContextWithPath<'coordinates' | 'limitsManager', '/world/:world_name/limits'>,
    'components' | 'params' | 'url'
  >
): Promise<IHttpServerComponent.IResponse> {
  const { coordinates, limitsManager } = ctx.components
  const worldName = ctx.params.world_name.toLowerCase()

  let parcels: string[] | undefined
  if (ctx.url.searchParams.has('parcels')) {
    const rawParcels = ctx.url.searchParams.getAll('parcels')
    validateParcels(rawParcels)
    for (const parcel of rawParcels) {
      try {
        coordinates.parseCoordinate(parcel)
      } catch (error) {
        throw new InvalidRequestError((error as Error).message)
      }
    }
    parcels = Array.from(new Set(coordinates.canonicalizeParcels(rawParcels)))
  }

  try {
    const [maxSceneSizeInBytes, maxParcels] = await Promise.all([
      limitsManager.getMaxAllowedSizeInBytesFor(worldName, parcels),
      limitsManager.getMaxAllowedParcelsFor(worldName)
    ])

    return {
      status: 200,
      body: { maxSceneSizeInBytes: maxSceneSizeInBytes.toString(), maxParcels }
    }
  } catch (error) {
    if (error instanceof WorldOwnerNotFoundError) {
      throw new NotFoundError(error.message)
    }
    throw error
  }
}
