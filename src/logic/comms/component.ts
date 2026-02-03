import { EthAddress } from '@dcl/crypto'
import { AppComponents } from '../../types'
import { InvalidWorldError, InvalidAccessError, SceneNotFoundError } from './errors'
import { ICommsComponent } from './types'

export const createCommsComponent = (
  components: Pick<AppComponents, 'namePermissionChecker' | 'access' | 'worlds' | 'commsAdapter'>
): ICommsComponent => {
  const { namePermissionChecker, access, worlds, commsAdapter } = components

  async function assertWorldAccess(
    userAddress: EthAddress,
    worldName: string,
    accessOptions?: { secret?: string }
  ): Promise<void> {
    if (!(await worlds.isWorldValid(worldName))) {
      throw new InvalidWorldError(worldName)
    }

    const [hasPermission, hasAccess] = await Promise.all([
      namePermissionChecker.checkPermission(userAddress, worldName),
      access.checkAccess(worldName, userAddress, accessOptions?.secret)
    ])

    if (!hasPermission || !hasAccess) {
      throw new InvalidAccessError(worldName)
    }
  }

  async function getWorldSceneRoomConnectionString(
    userAddress: EthAddress,
    worldName: string,
    sceneId: string,
    accessOptions?: { secret?: string }
  ): Promise<string> {
    await assertWorldAccess(userAddress, worldName, accessOptions)

    if (!(await worlds.hasWorldScene(worldName, sceneId))) {
      throw new SceneNotFoundError(worldName, sceneId)
    }

    return commsAdapter.getSceneRoomConnectionString(userAddress, worldName, sceneId)
  }

  async function getWorldRoomConnectionString(
    userAddress: EthAddress,
    worldName: string,
    accessOptions?: { secret?: string }
  ): Promise<string> {
    await assertWorldAccess(userAddress, worldName, accessOptions)

    return commsAdapter.getWorldRoomConnectionString(userAddress, worldName)
  }

  return {
    getWorldSceneRoomConnectionString,
    getWorldRoomConnectionString
  }
}
