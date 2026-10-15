import { SceneParcels } from '@dcl/schemas'
import { ICoordinatesComponent } from '../coordinates'

/**
 * Checks that the pointers of a scene deployment are a non-empty list of unique, canonical "x,y"
 * parcel coordinates (no leading zeros, whitespace or signed zero). It's the check
 * `createValidateScenePointers` applies to a deployment's pointers; bounds are checked separately.
 *
 * @param pointers - The parcel coordinates as declared
 * @returns Whether the pointers are deployable as a scene's parcels
 */
export function areValidScenePointers(pointers: string[]): boolean {
  return pointers.length > 0 && SceneParcels.validate({ base: pointers[0], parcels: pointers })
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
