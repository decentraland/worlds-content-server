import { InvalidRequestError } from '@dcl/http-commons'
import { MAX_PARCELS_PER_PERMISSION } from '../../types'
import { ICoordinatesComponent } from '../coordinates'

const PARCEL_REGEX = /^-?\d+,-?\d+$/

/**
 * Validates an array of parcels for permission assignment.
 * @param parcels - Array of parcel coordinates, null for world-wide, or undefined
 * @throws InvalidRequestError if validation fails
 */
export function validateParcels(parcels: string[] | null | undefined): void {
  if (parcels === null || parcels === undefined) {
    return
  }

  if (!Array.isArray(parcels)) {
    throw new InvalidRequestError('Parcels must be an array of coordinates.')
  }

  if (parcels.length > MAX_PARCELS_PER_PERMISSION) {
    throw new InvalidRequestError(
      `Cannot set more than ${MAX_PARCELS_PER_PERMISSION} parcels. Omit parcels parameter for world-wide access.`
    )
  }

  for (const parcel of parcels) {
    if (typeof parcel !== 'string' || !PARCEL_REGEX.test(parcel)) {
      throw new InvalidRequestError(
        `Invalid parcel format: "${parcel}". Expected "x,y" format (e.g., "0,0" or "-5,10").`
      )
    }
  }
}

/**
 * Returns the canonicalized, de-duplicated parcels a deployment targets: the set its permission,
 * dimensions and size are validated against. For an entity, pass its pointers —
 * `createValidateScenePointers` guarantees they equal `scene.parcels`.
 *
 * @param parcels - Parcel coordinates as declared
 * @param coordinates - Component used to canonicalize the parcels
 * @returns The canonical parcels, without duplicates, in first-seen order
 */
export function getDeploymentParcels(
  parcels: string[],
  coordinates: Pick<ICoordinatesComponent, 'canonicalizeParcels'>
): string[] {
  return Array.from(new Set(coordinates.canonicalizeParcels(parcels)))
}
