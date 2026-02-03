import { AppComponents, TWO_DAYS_IN_MS } from '../../types'
import { IWorldsComponent } from './types'

/**
 * Creates the Worlds component
 *
 * Orchestrates world validation operations:
 * 1. Checks if a world exists and has deployed scenes
 * 2. Validates blocked status and grace period
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

  async function hasWorldScene(worldName: string, sceneId: string): Promise<boolean> {
    const { scenes } = await worldsManager.getWorldScenes({ worldName, entityId: sceneId }, { limit: 1 })
    return scenes.length > 0
  }

  return {
    isWorldValid,
    isWorldBlocked,
    hasWorldScene
  }
}
