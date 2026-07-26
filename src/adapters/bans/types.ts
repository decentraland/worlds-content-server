/**
 * Device fingerprint and client IP observed for a connecting player, as far as the caller
 * knows them. Either may be absent; the comms-gatekeeper preserves whatever it already holds
 * for a field that is not reported.
 */
export type PlayerConnectionInput = {
  deviceId?: string
  ipAddress?: string
}

/**
 * Client for the comms-gatekeeper's ban surface.
 */
export interface IBansComponent {
  /**
   * Checks if the given address is banned from a specific scene in a world
   * by querying the comms-gatekeeper service.
   *
   * @param address - The wallet address to check.
   * @param worldName - The name of the world to check.
   * @param sceneBaseParcel - The base parcel of the scene to check.
   * @returns True if the user is banned, false otherwise.
   */
  isUserBannedFromScene(address: string, worldName: string, sceneBaseParcel: string): Promise<boolean>

  /**
   * Checks if the given connection is platform-banned by querying
   * the comms-gatekeeper service.
   *
   * @param address - The wallet address to check.
   * @param deviceId - Device fingerprint reported by the client, when present. An active ban
   * recorded against this device rejects the connection even under a different wallet.
   * @returns True if the connection is platform-banned, false otherwise.
   */
  isPlayerBanned(address: string, deviceId?: string): Promise<boolean>

  /**
   * Reports the connecting player's device and IP to the comms-gatekeeper, which keeps the
   * latest connection info per address and snapshots the device id when a ban is issued.
   *
   * This lives alongside the ban checks because the recorded device exists solely to feed them:
   * the comms-gatekeeper records it inline on its own token paths, and world tokens are issued
   * here without passing through those, so a player who only ever connects to multi-scene worlds
   * would otherwise be banned with no device captured.
   *
   * Best-effort — never throws, so it cannot block token issuance.
   *
   * @param address - The wallet address of the connecting player.
   * @param connection - Device fingerprint and client IP, when known.
   */
  recordPlayerConnection(address: string, connection: PlayerConnectionInput): Promise<void>
}
