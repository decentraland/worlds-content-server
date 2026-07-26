import { EthAddress } from '@dcl/crypto'

export type AccessOptions = {
  secret?: string
}

/**
 * Request-derived context for a comms token request: the world access secret plus the device
 * fingerprint the client reported in its signed-fetch metadata.
 */
export type ConnectionOptions = AccessOptions & {
  deviceId?: string
}

export type ICommsComponent = {
  getWorldSceneRoomConnectionString(
    userId: EthAddress,
    worldName: string,
    sceneId: string,
    connectionOptions?: ConnectionOptions
  ): Promise<string>
  getWorldRoomConnectionString(
    userId: EthAddress,
    worldName: string,
    connectionOptions?: ConnectionOptions
  ): Promise<string>
}
