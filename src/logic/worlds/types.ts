import { WorldManifest } from '../../types'

export interface IWorldsComponent {
  /**
   * Checks if a world exists and is valid (has scenes and is not blocked beyond grace period)
   *
   * @param worldName - The name of the world to check
   * @returns true if the world exists and is valid, false otherwise
   */
  isWorldValid(worldName: string): Promise<boolean>

  /**
   * Checks if a world is blocked and beyond the grace period
   *
   * @param blockedSince - The date when the world was blocked, or undefined if not blocked
   * @returns true if the world is blocked and beyond the grace period, false otherwise
   */
  isWorldBlocked(blockedSince: Date | undefined): boolean

  /**
   * Checks if a world has a scene
   *
   * @param worldName - The name of the world to check
   * @param sceneId - The ID of the scene to check
   * @returns true if the world has the scene, false otherwise
   */
  hasWorldScene(worldName: string, sceneId: string): Promise<boolean>

  /**
   * Gets the base parcel of a scene in a world by its entity ID.
   *
   * @param worldName - The name of the world
   * @param sceneId - The entity ID of the scene
   * @returns The base parcel coordinate (e.g. '0,0') if found, undefined otherwise
   */
  getWorldSceneBaseParcel(worldName: string, sceneId: string): Promise<string | undefined>

  /**
   * Gets the world manifest containing all occupied parcels and spawn coordinates
   *
   * @param worldName - The name of the world
   * @returns WorldManifest with parcels and spawnCoordinates, or undefined if no scenes exist
   */
  getWorldManifest(worldName: string): Promise<WorldManifest | undefined>

  /**
   * Undeploys an entire world by removing all its scenes and publishing a WorldUndeploymentEvent
   *
   * @param worldName - The name of the world to undeploy
   */
  undeployWorld(worldName: string): Promise<void>

  /**
   * Undeploys specific scenes from a world by parcels and publishes a WorldScenesUndeploymentEvent
   *
   * @param worldName - The name of the world
   * @param parcels - The parcel coordinates of the scenes to undeploy
   */
  undeployWorldScenes(worldName: string, parcels: string[]): Promise<void>
}
