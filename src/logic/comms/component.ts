import { EthAddress } from '@dcl/crypto'
import { AppComponents } from '../../types'
import {
  InvalidWorldError,
  InvalidAccessError,
  SceneNotFoundError,
  WorldAtCapacityError,
  UserDenylistedError,
  UserBannedFromWorldError
} from './errors'
import { DEFAULT_MAX_USERS_PER_WORLD } from './constants'
import { ICommsComponent } from './types'

export const createCommsComponent = async (
  components: Pick<
    AppComponents,
    'namePermissionChecker' | 'access' | 'worlds' | 'commsAdapter' | 'config' | 'denyList' | 'bans'
  >
): Promise<ICommsComponent> => {
  const { namePermissionChecker, access, worlds, commsAdapter, config, denyList, bans } = components
  const maxUsersPerWorld = (await config.getNumber('MAX_USERS_PER_WORLD')) ?? DEFAULT_MAX_USERS_PER_WORLD

  async function assertUserNotDenylisted(userAddress: EthAddress): Promise<void> {
    const isDenylisted = await denyList.isDenylisted(userAddress)
    if (isDenylisted) {
      throw new UserDenylistedError()
    }
  }

  async function assertUserNotBannedFromScene(
    userAddress: EthAddress,
    worldName: string,
    sceneBaseParcel: string
  ): Promise<void> {
    const isBanned = await bans.isUserBannedFromScene(userAddress, worldName, sceneBaseParcel)
    if (isBanned) {
      throw new UserBannedFromWorldError(worldName)
    }
  }

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
    await assertUserNotDenylisted(userAddress)
    await assertWorldAccess(userAddress, worldName, accessOptions)

    const sceneBaseParcel = await worlds.getWorldSceneBaseParcel(worldName, sceneId)
    if (!sceneBaseParcel) {
      throw new SceneNotFoundError(worldName, sceneId)
    }

    await assertUserNotBannedFromScene(userAddress, worldName, sceneBaseParcel)

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
    await assertUserNotDenylisted(userAddress)
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
