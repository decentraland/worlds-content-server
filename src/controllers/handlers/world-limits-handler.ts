import { IHttpServerComponent } from '@dcl/core-commons'
import { InvalidRequestError, NotFoundError } from '@dcl/http-commons'
import { HandlerContextWithPath } from '../../types'
import { WorldOwnerNotFoundError } from '../../adapters/limits-manager'
import { areValidScenePointers, getDeploymentParcels } from '../../logic/validations/parcels'

/**
 * Returns the scene limits a deployment to the world is checked against.
 *
 * `maxParcels` always matches the deployment validation. `maxSceneSizeInBytes` matches it exactly
 * when `parcels` lists the scene's parcels: only the deployed scenes overlapping them are credited
 * back. Without `parcels` the whole world's deployed size is credited back, so the result is an
 * upper bound: a deployment that doesn't replace every scene of the world may get a lower limit.
 *
 * `parcels` must pass the same format and bounds checks as a deployment's pointers (unique,
 * canonical, in bounds). A 200 doesn't mean the list is deployable: a deployment can still be
 * rejected for exceeding `maxParcels` or for missing permissions. The query string shares Node's
 * 16 KB request header limit with every other header, so depending on coordinate length and on
 * `,` being encoded as `%2C`, lists above roughly 800 to 1,300 parcels get a 431 (or a 414 from a
 * proxy) before reaching this handler.
 *
 * @throws {InvalidRequestError} When the parcels aren't unique canonical "x,y" coordinates or a
 * parcel is out of bounds.
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
    const requestedParcels = ctx.url.searchParams.getAll('parcels')
    if (!areValidScenePointers(requestedParcels)) {
      throw new InvalidRequestError('Parcels must be unique canonical "x,y" coordinates, as in a scene\'s parcels.')
    }
    for (const parcel of requestedParcels) {
      try {
        coordinates.parseCoordinate(parcel)
      } catch (error) {
        throw new InvalidRequestError((error as Error).message)
      }
    }
    // A no-op for valid parcels; shared so every size-limit caller derives them the same way.
    parcels = getDeploymentParcels(requestedParcels, coordinates)
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
