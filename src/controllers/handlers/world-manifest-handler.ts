import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { NotFoundError } from '@dcl/http-commons'

/**
 * Response schema for the world manifest endpoint
 */
export type WorldManifestResponse = {
  occupied: string[]
  spawn_coordinate: { x: string; y: string }
  total: number
}

/**
 * Handles GET /world/:world_name/manifest
 *
 * Returns the world manifest containing:
 * - occupied: List of occupied parcels in "x,y" format
 * - spawn_coordinate: The world's spawn coordinates with x and y as separate string fields
 * - total: Total number of occupied parcels
 *
 * @param ctx - Handler context with worlds component
 * @returns World manifest response with 200 status, or 404 if world not found
 * @throws {NotFoundError} If the world does not exist or has no scenes deployed
 */
export async function getWorldManifestHandler(
  ctx: HandlerContextWithPath<'worlds' | 'nameDenyListChecker', '/world/:world_name/manifest'>
): Promise<IHttpServerComponent.IResponse> {
  const { worlds, nameDenyListChecker } = ctx.components
  const worldName = ctx.params.world_name

  // Check if world name is not on deny list
  if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
    throw new NotFoundError(`World "${worldName}" not found.`)
  }

  // Get all parcels and spawn coordinates from worlds component
  const manifest = await worlds.getWorldManifest(worldName)

  if (!manifest) {
    throw new NotFoundError(`World "${worldName}" has no scenes deployed.`)
  }

  const { parcels, spawnCoordinates, total } = manifest

  // Parse spawn coordinates or default to first parcel
  let spawnX: string
  let spawnY: string

  if (spawnCoordinates) {
    const [x, y] = spawnCoordinates.split(',')
    spawnX = x
    spawnY = y
  } else if (parcels.length > 0) {
    // Default to first occupied parcel if no spawn coordinates set
    const [x, y] = parcels[0].split(',')
    spawnX = x
    spawnY = y
  } else {
    // Fallback if no parcels (shouldn't happen due to earlier check)
    spawnX = '0'
    spawnY = '0'
  }

  const body: WorldManifestResponse = {
    occupied: parcels,
    spawn_coordinate: { x: spawnX, y: spawnY },
    total
  }

  return {
    status: 200,
    body
  }
}
