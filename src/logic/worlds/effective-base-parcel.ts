import { WorldScene } from '../../types'
import { ICoordinatesComponent } from '../coordinates'

/**
 * Resolves the canonical parcel used as a scene's downstream identity.
 *
 * The declared base is trusted only when it belongs to the canonicalized stored parcel set.
 * Corrupt rows without stored parcels have no effective identity and return undefined.
 */
export function effectiveBaseParcel(
  scene: Pick<WorldScene, 'entity' | 'parcels'>,
  coordinates: Pick<ICoordinatesComponent, 'canonicalizeParcel' | 'canonicalizeParcels'>
): string | undefined {
  const canonicalParcels = coordinates.canonicalizeParcels(scene.parcels)
  const base = scene.entity.metadata?.scene?.base
  if (typeof base === 'string' && base.length > 0) {
    const canonicalBase = coordinates.canonicalizeParcel(base)
    if (canonicalParcels.includes(canonicalBase)) {
      return canonicalBase
    }
  }
  return canonicalParcels[0]
}
