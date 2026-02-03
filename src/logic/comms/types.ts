import { EthAddress } from '@dcl/crypto'

export type AccessOptions = {
  secret?: string
}

export type ICommsComponent = {
  getWorldSceneRoomConnectionString(
    userId: EthAddress,
    worldName: string,
    sceneId: string,
    accessOptions?: AccessOptions
  ): Promise<string>
  getWorldRoomConnectionString(userId: EthAddress, worldName: string, accessOptions?: AccessOptions): Promise<string>
}
