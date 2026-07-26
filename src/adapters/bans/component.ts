import { ILoggerComponent } from '@well-known-components/interfaces'
import { AppComponents } from '../../types'
import { withRetry } from '../../logic/utils'
import { PermanentGatekeeperError } from './errors'
import { IBansComponent, PlayerConnectionInput } from './types'

/** Header the comms-gatekeeper reads the connecting client's device fingerprint from. */
const DEVICE_ID_HEADER = 'X-Device-Id'

/**
 * The device id originates in client-controlled signed-fetch metadata, so it may be arbitrary.
 * Forward it only when it is an opaque, bounded token — the real fingerprint is a SHA-256 hex
 * digest. Anything else is treated as absent, which is exactly how a client that reports no
 * device is handled, and keeps unusable values out of the outbound header.
 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function toHeaderSafeDeviceId(deviceId?: string): string | undefined {
  return deviceId && DEVICE_ID_PATTERN.test(deviceId) ? deviceId : undefined
}

const isRetryable = (error: unknown): boolean => !(error instanceof PermanentGatekeeperError)

function assertOkResponse(response: { ok: boolean; status: number }, operation: string): void {
  if (response.ok) {
    return
  }

  const message = `Unexpected response from comms-gatekeeper ${operation}: ${response.status}`
  throw response.status >= 400 && response.status < 500 ? new PermanentGatekeeperError(message) : new Error(message)
}

/** Permanent failures are operator-actionable; transient ones are noise until they persist. */
function logGatekeeperFailure(
  logger: ILoggerComponent.ILogger,
  error: unknown,
  message: string,
  context: Record<string, string>
): void {
  const details = { ...context, error: error instanceof Error ? error.message : String(error) }

  if (error instanceof PermanentGatekeeperError) {
    logger.error(`${message} (permanent, not retried)`, details)
  } else {
    logger.warn(message, details)
  }
}

/**
 * Creates the Bans adapter.
 *
 * Client for the comms-gatekeeper's ban surface:
 *   - `GET /worlds/:worldName/parcels/:sceneBaseParcel/users/:address/ban-status` — scene bans.
 *   - `GET /users/:address/ban-status` — platform bans, matched on address or device.
 *   - `POST /users/:address/connection-info` — records the device a later ban will snapshot.
 *
 * Authenticates with a bearer token. Every call fails open, so a comms-gatekeeper outage cannot
 * block world connections; 4xx responses are treated as permanent and are not retried.
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
      // Retry transient failures (5xx, dropped/reset connections from undici's keep-alive pool),
      // then fail open on exhaustion. 4xx is permanent and gives up immediately.
      const body = await withRetry<{ isBanned: boolean }>(
        async () => {
          const response = await fetch.fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${authToken}`
            }
          })

          assertOkResponse(response, 'scene ban check')

          return (await response.json()) as { isBanned: boolean }
        },
        { logger, maxRetries: 3, shouldRetry: isRetryable }
      )

      return body.isBanned
    } catch (error) {
      logGatekeeperFailure(logger, error, 'Error checking scene ban status, allowing user through', {
        address,
        worldName,
        sceneBaseParcel
      })
      return false
    }
  }

  /**
   * Checks if the given connection is platform-banned, by address or by device id.
   *
   * @param address - The wallet address to check.
   * @param deviceId - Device fingerprint reported by the client, when present.
   * @returns True if the connection is platform-banned. Returns false on errors (fail open).
   */
  async function isPlayerBanned(address: string, deviceId?: string): Promise<boolean> {
    // Device-aware endpoint: matches an active ban on the address OR the recorded device id.
    // The public /users/:address/bans matches on address only, so it would let a banned
    // device reconnect under a different wallet.
    const url = `${commsGatekeeperUrl}/users/${encodeURIComponent(address.toLowerCase())}/ban-status`

    // Header, not a query parameter: the gatekeeper's request logger writes the query string at
    // INFO, which would persist this stable cross-wallet machine identifier on every connection.
    const safeDeviceId = toHeaderSafeDeviceId(deviceId)

    // Dropping the device id downgrades this to an address-only check, so say so. The client's
    // fingerprint format is explicitly versioned for rotation; if it ever stops matching, the
    // ban silently weakens and this warning is the only signal. The value itself is never
    // logged — keeping it out of logs is the reason it travels in a header.
    if (deviceId && !safeDeviceId) {
      logger.warn('Ignoring malformed device id, checking the ban by address only', { address })
    }

    try {
      const body = await withRetry<{ isBanned: boolean }>(
        async () => {
          const response = await fetch.fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${authToken}`,
              ...(safeDeviceId ? { [DEVICE_ID_HEADER]: safeDeviceId } : {})
            }
          })

          assertOkResponse(response, 'platform ban check')

          return (await response.json()) as { isBanned: boolean }
        },
        { logger, maxRetries: 3, shouldRetry: isRetryable }
      )

      return body.isBanned === true
    } catch (error) {
      logGatekeeperFailure(logger, error, 'Error checking player ban status, allowing user through', { address })
      return false
    }
  }

  /**
   * Reports the connecting player's device and IP so a later ban can snapshot the device.
   *
   * @param address - The wallet address of the connecting player.
   * @param connection - Device fingerprint and client IP, when known.
   */
  async function recordPlayerConnection(address: string, connection: PlayerConnectionInput): Promise<void> {
    // Record exactly the device id the ban check would match on. Recording a value the check
    // would refuse to send produces a stored device that can never be matched later.
    const deviceId = toHeaderSafeDeviceId(connection.deviceId)

    // Nothing worth reporting: the gatekeeper COALESCEs absent fields, so an empty body would
    // only cost a round-trip and bump updated_at.
    if (!deviceId && !connection.ipAddress) {
      return
    }

    const url = `${commsGatekeeperUrl}/users/${encodeURIComponent(address.toLowerCase())}/connection-info`

    try {
      await withRetry(
        async () => {
          const response = await fetch.fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${authToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ deviceId, ipAddress: connection.ipAddress })
          })

          assertOkResponse(response, 'connection recording')
        },
        { logger, maxRetries: 2, shouldRetry: isRetryable }
      )
    } catch (error) {
      // Swallowed on purpose: recording is telemetry for future bans, never a gate on this
      // connection. A gatekeeper outage must not stop a legitimate player entering a world.
      logGatekeeperFailure(logger, error, 'Error recording player connection info', { address })
    }
  }

  return {
    isUserBannedFromScene,
    isPlayerBanned,
    recordPlayerConnection
  }
}
