import { IHttpServerComponent } from '@dcl/core-commons'
import { InvalidRequestError, NotFoundError } from '@dcl/http-commons'
import { HandlerContextWithPath } from '../../types'
import { WorldOwnerNotFoundError } from '../../adapters/limits-manager'
import { MAX_WORLD_PARCELS } from '../../logic/coordinates'
import { getDeploymentParcels } from '../../logic/validations/parcels'

/**
 * Returns the scene limits a deployment to the world is checked against.
 *
 * `maxParcels` always matches the deployment validation. `maxSceneSizeInBytes` matches it exactly
 * when `parcels` lists the scene's parcels: they are canonicalized and deduplicated the way the
 * deployment's pointers are, so only the deployed scenes overlapping them are credited back.
 * Without `parcels` the whole world's deployed size is credited back, so the result is an upper
 * bound: a deployment that doesn't replace every scene of the world may get a lower limit.
 *
 * @throws {InvalidRequestError} When a parcel is malformed or out of bounds, or there are more
 * parcels than the world grid holds.
 * @throws {NotFoundError} When the world name is deny-listed or its owner can't be determined.
 */
export async function getWorldLimitsHandler(
  ctx: Pick<
    HandlerContextWithPath<'coordinates' | 'limitsManager' | 'nameDenyListChecker', '/world/:world_name/limits'>,
    'components' | 'params' | 'url'
  >
): Promise<IHttpServerComponent.IResponse> {
  const { coordinates, limitsManager, nameDenyListChecker } = ctx.components
  const worldName = ctx.params.world_name.toLowerCase()

  let parcels: string[] | undefined
  if (ctx.url.searchParams.has('parcels')) {
    const rawParcels = ctx.url.searchParams.getAll('parcels')
    // A scene can't occupy more parcels than the grid holds, so this never rejects a deployment.
    if (rawParcels.length > MAX_WORLD_PARCELS) {
      throw new InvalidRequestError(
        `Cannot compute limits for more than ${MAX_WORLD_PARCELS} parcels, the size of the world grid.`
      )
    }
    for (const parcel of rawParcels) {
      try {
        coordinates.parseCoordinate(parcel)
      } catch (error) {
        throw new InvalidRequestError((error as Error).message)
      }
    }
    parcels = getDeploymentParcels(rawParcels, coordinates)
  }

  if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
    throw new NotFoundError(`World "${worldName}" not found.`)
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
