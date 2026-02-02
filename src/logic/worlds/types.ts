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
}
