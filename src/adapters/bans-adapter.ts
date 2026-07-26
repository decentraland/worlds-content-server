import { AppComponents } from '../types'
import { withRetry } from '../logic/utils'

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

  /**
   * Checks if the given connection is platform-banned by querying
   * the comms-gatekeeper service.
   *
   * @param address - The wallet address to check.
   * @param deviceId - Device fingerprint reported by the client, when present. An active ban
   * recorded against this device rejects the connection even under a different wallet.
   * @returns True if the connection is platform-banned, false otherwise.
   */
  isPlayerBanned: (address: string, deviceId?: string) => Promise<boolean>
}

/**
 * Creates the Bans adapter.
 *
 * Calls the comms-gatekeeper's GET /worlds/:worldName/parcels/:sceneBaseParcel/users/:address/ban-status
 * endpoint to determine if a user is banned from a specific scene in a world, and its
 * GET /users/:address/ban-status endpoint to determine if a connection is platform-banned.
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
    const url = `${commsGatekeeperUrl}/worlds/${encodeURIComponent(worldName)}/parcels/${encodeURIComponent(sceneBaseParcel)}/users/${encodeURIComponent(address)}/ban-status`
    try {
      // Retry transient failures (5xx, dropped/reset connections from undici's keep-alive pool):
      // a non-2xx response is thrown so withRetry re-attempts it, then we fail open on exhaustion.
      const body = await withRetry<{ isBanned: boolean }>(
        async () => {
          const response = await fetch.fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${authToken}`
            }
          })

          if (!response.ok) {
            throw new Error(`Unexpected response from comms-gatekeeper ban check: ${response.status}`)
          }

          return (await response.json()) as { isBanned: boolean }
        },
        { logger, maxRetries: 3 }
      )

      return body.isBanned
    } catch (error) {
      logger.warn(
        `Error checking ban status for ${address} in scene ${sceneBaseParcel} of world ${worldName}: ${error}`
      )
      return false
    }
  }

  async function isPlayerBanned(address: string, deviceId?: string): Promise<boolean> {
    // Device-aware endpoint: matches an active ban on the address OR the recorded device id.
    // The public /users/:address/bans matches on address only, so it would let a banned
    // device reconnect under a different wallet.
    const url = new URL(`${commsGatekeeperUrl}/users/${encodeURIComponent(address.toLowerCase())}/ban-status`)
    if (deviceId) {
      url.searchParams.set('deviceId', deviceId)
    }

    try {
      const body = await withRetry<{ isBanned: boolean }>(
        async () => {
          const response = await fetch.fetch(url.toString(), {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${authToken}`
            }
          })

          if (!response.ok) {
            throw new Error(`Unexpected response from comms-gatekeeper platform ban check: ${response.status}`)
          }

          return (await response.json()) as { isBanned: boolean }
        },
        { logger, maxRetries: 3 }
      )

      return body.isBanned === true
    } catch (error) {
      logger.warn('Error checking player ban status, allowing user through', {
        error: error instanceof Error ? error.message : String(error),
        address
      })
      return false
    }
  }

  return {
    isUserBannedFromScene,
    isPlayerBanned
  }
}
