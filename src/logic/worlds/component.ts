import { Events, WorldScenesUndeploymentEvent, WorldUndeploymentEvent } from '@dcl/schemas'
import { AppComponents, TWO_DAYS_IN_MS, WorldManifest, WorldScene } from '../../types'
import { IWorldsComponent } from './types'

/**
 * The scene's DECLARED base parcel (metadata.scene.base) — the value both the Places service
 * (place base_position) and the comms-gatekeeper scene-ban lookup key scene identity on. Falls back
 * to parcels[0] only when the stored entity lacks a valid (non-empty string) base. Using parcels[0]
 * directly is wrong when the base isn't the first parcel in the array: it points at a different
 * scene identity, so places/ban lookups keyed on the base would miss.
 */
function declaredBaseParcel(scene: WorldScene): string {
  const base = scene.entity.metadata?.scene?.base
  return typeof base === 'string' && base.length > 0 ? base : scene.parcels[0]
}

/**
 * Creates the Worlds component
 *
 * Orchestrates world validation, data operations, and undeployment flows:
 * 1. Checks if a world exists and has deployed scenes
 * 2. Validates blocked status and grace period
 * 3. Composes world manifest from parcels and settings
 * 4. Handles world and scene undeployment with event publishing
 * 5. Rechecks the owner's blocked status after freeing space
 *
 * @param components Required components: blocking, snsClient, worldsManager
 * @returns IWorldsComponent implementation
 */
export const createWorldsComponent = (
  components: Pick<AppComponents, 'blocking' | 'snsClient' | 'worldsManager'>
): IWorldsComponent => {
  const { blocking, snsClient, worldsManager } = components

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
    return scenes.length > 0 ? declaredBaseParcel(scenes[0]) : undefined
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
   * Captures the world owner before an undeployment, but only when that owner is currently
   * blocked — so callers can cheaply skip the (expensive) quota recheck for the common case
   * of an owner that was never blocked. Must be called before the scenes are removed, since
   * the world record is needed to resolve the owner.
   *
   * @param worldName - The name of the world about to be undeployed
   * @returns The owner address when it is currently blocked, undefined otherwise
   */
  async function getBlockedOwner(worldName: string): Promise<string | undefined> {
    const { records } = await worldsManager.getRawWorldRecords({ worldName })
    const record = records[0]
    if (!record || !record.owner || !record.blocked_since) {
      return undefined
    }
    return record.owner
  }

  /**
   * Rechecks a (previously blocked) owner's quota after space was freed, unblocking them when
   * they are back under quota. Best-effort: unblockIfUnderQuota logs and swallows its own
   * errors, so a failed recheck never affects the undeployment that triggered it.
   *
   * @param blockedOwner - The owner returned by getBlockedOwner, or undefined to skip
   */
  async function recheckBlockedOwner(blockedOwner: string | undefined): Promise<void> {
    if (blockedOwner) {
      await blocking.unblockIfUnderQuota(blockedOwner)
    }
  }

  /**
   * Undeploys an entire world by removing all its scenes and publishing a WorldUndeploymentEvent
   *
   * @param worldName - The name of the world to undeploy
   */
  async function undeployWorld(worldName: string): Promise<void> {
    const blockedOwner = await getBlockedOwner(worldName)

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

    await recheckBlockedOwner(blockedOwner)
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
    const blockedOwner = await getBlockedOwner(worldName)

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
            // Emit the scene's DECLARED base parcel (see declaredBaseParcel) — the value Places keys
            // its place records on — not parcels[0]; otherwise the undeployment would fail to disable
            // the place for scenes whose base isn't the first parcel.
            baseParcel: declaredBaseParcel(scene)
          }))
        }
      }

      await snsClient.publishMessages([event])
    }

    await recheckBlockedOwner(blockedOwner)
  }

  async function getWorldSceneBaseParcelIncludingUndeployed(
    worldName: string,
    sceneId: string
  ): Promise<string | undefined> {
    const { scenes } = await worldsManager.getWorldScenes(
      { worldName, entityId: sceneId, includeUndeployed: true },
      { limit: 1 }
    )
    return scenes.length > 0 ? declaredBaseParcel(scenes[0]) : undefined
  }

  async function evictUndeployedWorlds(olderThanMs: number): Promise<number> {
    return worldsManager.evictUndeployedScenes(olderThanMs)
  }

  return {
    isWorldValid,
    isWorldBlocked,
    hasWorldScene,
    getWorldSceneBaseParcel,
    getWorldManifest,
    undeployWorld,
    undeployWorldScenes,
    getWorldSceneBaseParcelIncludingUndeployed,
    evictUndeployedWorlds
  }
}
