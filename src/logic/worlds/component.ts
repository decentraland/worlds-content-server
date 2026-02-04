import { AppComponents, TWO_DAYS_IN_MS, WorldManifest } from '../../types'
import { IWorldsComponent } from './types'

/**
 * Creates the Worlds component
 *
 * Orchestrates world validation and data operations:
 * 1. Checks if a world exists and has deployed scenes
 * 2. Validates blocked status and grace period
 * 3. Composes world manifest from parcels and settings
 *
 * @param components Required components: worldsManager
 * @returns IWorldsComponent implementation
 */
export const createWorldsComponent = (components: Pick<AppComponents, 'worldsManager'>): IWorldsComponent => {
  const { worldsManager } = components

  /**
   * Checks if a world is blocked and beyond the grace period
   *
   * @param blockedSince - The date when the world was blocked, or undefined if not blocked
   * @returns true if the world is blocked and beyond the grace period, false otherwise
   */
  function isWorldBlocked(blockedSince: Date | undefined): boolean {
    if (blockedSince) {
      const now = new Date()
      if (now.getTime() - blockedSince.getTime() > TWO_DAYS_IN_MS) {
        return true
      }
    }
    return false
  }

  /**
   * Checks if a world exists and is valid (has scenes and is not blocked beyond grace period)
   *
   * @param worldName - The name of the world to check
   * @returns true if the world exists and is valid, false otherwise
   */
  async function isWorldValid(worldName: string): Promise<boolean> {
    const { records } = await worldsManager.getRawWorldRecords({ worldName })

    // World doesn't exist
    if (records.length === 0) {
      return false
    }

    const worldRecord = records[0]

    // Check if world is blocked and beyond the grace period
    const blockedSince = worldRecord.blocked_since ? new Date(worldRecord.blocked_since) : undefined
    return !isWorldBlocked(blockedSince)
  }

  /**
   * Checks if a world has a scene
   *
   * @param worldName - The name of the world to check
   * @param sceneId - The ID of the scene to check
   * @returns true if the world has the scene, false otherwise
   */
  async function hasWorldScene(worldName: string, sceneId: string): Promise<boolean> {
    const { scenes } = await worldsManager.getWorldScenes({ worldName, entityId: sceneId }, { limit: 1 })
    return scenes.length > 0
  }

  /**
   * Gets the world manifest containing occupied parcels and spawn coordinates
   *
   * This method combines getOccupiedParcels and getWorldSettings for efficiency:
   * - Separate queries avoid redundant data transfer (spawn_coordinates not repeated per parcel)
   * - Queries run in parallel for better performance
   *
   * Note: Parcels are capped at 500 for the time being. The total count reflects
   * the actual number of occupied parcels in the world.
   *
   * @param worldName - The name of the world
   * @returns WorldManifest with parcels (capped at 500), spawnCoordinates, and total count, or undefined if no scenes exist
   */
  async function getWorldManifest(worldName: string): Promise<WorldManifest | undefined> {
    // Parcels are capped at 500 for the time being
    const PARCELS_LIMIT = 500

    // Run both queries in parallel for better performance
    const [occupiedParcelsResult, settings] = await Promise.all([
      worldsManager.getOccupiedParcels(worldName, { limit: PARCELS_LIMIT }),
      worldsManager.getWorldSettings(worldName)
    ])

    if (occupiedParcelsResult.total === 0) {
      return undefined
    }

    return {
      parcels: occupiedParcelsResult.parcels,
      spawnCoordinates: settings?.spawnCoordinates ?? null,
      total: occupiedParcelsResult.total
    }
  }

  return {
    isWorldValid,
    isWorldBlocked,
    hasWorldScene,
    getWorldManifest
  }
}
