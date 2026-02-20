import { Events, WorldScenesUndeploymentEvent, WorldUndeploymentEvent } from '@dcl/schemas'
import { AppComponents, TWO_DAYS_IN_MS, WorldManifest } from '../../types'
import { IWorldsComponent } from './types'

/**
 * Creates the Worlds component
 *
 * Orchestrates world validation, data operations, and undeployment flows:
 * 1. Checks if a world exists and has deployed scenes
 * 2. Validates blocked status and grace period
 * 3. Composes world manifest from parcels and settings
 * 4. Handles world and scene undeployment with event publishing
 *
 * @param components Required components: worldsManager, snsClient
 * @returns IWorldsComponent implementation
 */
export const createWorldsComponent = (
  components: Pick<AppComponents, 'worldsManager' | 'snsClient'>
): IWorldsComponent => {
  const { worldsManager, snsClient } = components

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
   * Gets the base parcel of a scene in a world by its entity ID.
   *
   * @param worldName - The name of the world
   * @param sceneId - The entity ID of the scene
   * @returns The base parcel coordinate (e.g. '0,0') if found, undefined otherwise
   */
  async function getWorldSceneBaseParcel(worldName: string, sceneId: string): Promise<string | undefined> {
    const { scenes } = await worldsManager.getWorldScenes({ worldName, entityId: sceneId }, { limit: 1 })
    return scenes.length > 0 ? scenes[0].parcels[0] : undefined
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

  /**
   * Undeploys an entire world by removing all its scenes and publishing a WorldUndeploymentEvent
   *
   * @param worldName - The name of the world to undeploy
   */
  async function undeployWorld(worldName: string): Promise<void> {
    await worldsManager.undeployWorld(worldName)

    const event: WorldUndeploymentEvent = {
      type: Events.Type.WORLD,
      subType: Events.SubType.Worlds.WORLD_UNDEPLOYMENT,
      key: worldName,
      timestamp: Date.now(),
      metadata: {
        worldName
      }
    }

    await snsClient.publishMessages([event])
  }

  /**
   * Undeploys specific scenes from a world by parcels and publishes a WorldScenesUndeploymentEvent
   *
   * Queries affected scenes before deletion to capture entity IDs and base parcels
   * for the event payload.
   *
   * @param worldName - The name of the world
   * @param parcels - The parcel coordinates of the scenes to undeploy
   */
  async function undeployWorldScenes(worldName: string, parcels: string[]): Promise<void> {
    // Query affected scenes before deletion to get entity IDs and base parcels
    const { scenes } = await worldsManager.getWorldScenes({ worldName, coordinates: parcels })

    await worldsManager.undeployScene(worldName, parcels)

    if (scenes.length > 0) {
      const event: WorldScenesUndeploymentEvent = {
        type: Events.Type.WORLD,
        subType: Events.SubType.Worlds.WORLD_SCENES_UNDEPLOYMENT,
        key: worldName,
        timestamp: Date.now(),
        metadata: {
          worldName,
          scenes: scenes.map((scene) => ({
            entityId: scene.entityId,
            baseParcel: scene.parcels[0]
          }))
        }
      }

      await snsClient.publishMessages([event])
    }
  }

  return {
    isWorldValid,
    isWorldBlocked,
    hasWorldScene,
    getWorldSceneBaseParcel,
    getWorldManifest,
    undeployWorld,
    undeployWorldScenes
  }
}
