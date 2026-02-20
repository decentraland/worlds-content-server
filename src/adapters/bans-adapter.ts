import { AppComponents } from '../types'

/**
 * Component interface for checking if a user is banned from a world scene.
 */
export type IBansComponent = {
  /**
   * Checks if the given address is banned from a specific scene in a world
   * by querying the comms-gatekeeper service.
   *
   * @param address - The wallet address to check.
   * @param worldName - The name of the world to check.
   * @param sceneBaseParcel - The base parcel of the scene to check.
   * @returns True if the user is banned, false otherwise.
   */
  isUserBannedFromScene: (address: string, worldName: string, sceneBaseParcel: string) => Promise<boolean>
}

/**
 * Creates the Bans adapter.
 *
 * Calls the comms-gatekeeper's GET /worlds/:worldName/parcels/:sceneBaseParcel/users/:address/ban-status
 * endpoint to determine if a user is banned from a specific scene in a world.
 * Authenticates using a bearer token. Fails open (returns false) on any error
 * to avoid blocking world connections when the comms-gatekeeper is unavailable.
 *
 * @param components Required components: config, fetch, logs
 * @returns IBansComponent implementation
 */
export async function createBansComponent(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs'>
): Promise<IBansComponent> {
  const { config, fetch, logs } = components
  const logger = logs.getLogger('bans')

  const commsGatekeeperUrl = await config.requireString('COMMS_GATEKEEPER_URL')
  const authToken = await config.requireString('COMMS_GATEKEEPER_AUTH_TOKEN')

  /**
   * Checks if the given address is banned from a specific scene in a world
   * by querying the comms-gatekeeper service.
   *
   * @param address - The wallet address to check.
   * @param worldName - The name of the world to check.
   * @param sceneBaseParcel - The base parcel of the scene to check.
   * @returns True if the user is banned, false otherwise. Returns false on errors (fail open).
   */
  async function isUserBannedFromScene(address: string, worldName: string, sceneBaseParcel: string): Promise<boolean> {
    try {
      const url = `${commsGatekeeperUrl}/worlds/${encodeURIComponent(worldName)}/parcels/${encodeURIComponent(sceneBaseParcel)}/users/${encodeURIComponent(address)}/ban-status`
      const response = await fetch.fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      })

      if (!response.ok) {
        logger.warn(`Unexpected response from comms-gatekeeper ban check: ${response.status}`)
        return false
      }

      const body: { isBanned: boolean } = await response.json()
      return body.isBanned
    } catch (error) {
      logger.warn(
        `Error checking ban status for ${address} in scene ${sceneBaseParcel} of world ${worldName}: ${error}`
      )
      return false
    }
  }

  return {
    isUserBannedFromScene
  }
}
