import { EthAddress } from '@dcl/crypto'
import { AppComponents } from '../../types'
import { InvalidWorldError, InvalidAccessError, SceneNotFoundError, WorldAtCapacityError } from './errors'
import { DEFAULT_MAX_USERS_PER_WORLD } from './constants'
import { ICommsComponent } from './types'

export const createCommsComponent = async (
  components: Pick<AppComponents, 'namePermissionChecker' | 'access' | 'worlds' | 'commsAdapter' | 'config'>
): Promise<ICommsComponent> => {
  const { namePermissionChecker, access, worlds, commsAdapter, config } = components
  const maxUsersPerWorld = (await config.getNumber('MAX_USERS_PER_WORLD')) ?? DEFAULT_MAX_USERS_PER_WORLD

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

    if (!hasPermission && !hasAccess) {
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

    const participantCount = await commsAdapter.getWorldSceneRoomsParticipantCount(worldName)
    if (participantCount >= maxUsersPerWorld) {
      throw new WorldAtCapacityError(worldName)
    }

    return commsAdapter.getSceneRoomConnectionString(userAddress, worldName, sceneId)
  }

  async function getWorldRoomConnectionString(
    userAddress: EthAddress,
    worldName: string,
    accessOptions?: { secret?: string }
  ): Promise<string> {
    await assertWorldAccess(userAddress, worldName, accessOptions)

    const participantCount = await commsAdapter.getWorldRoomParticipantCount(worldName)
    if (participantCount >= maxUsersPerWorld) {
      throw new WorldAtCapacityError(worldName)
    }

    return commsAdapter.getWorldRoomConnectionString(userAddress, worldName)
  }

  return {
    getWorldSceneRoomConnectionString,
    getWorldRoomConnectionString
  }
}
