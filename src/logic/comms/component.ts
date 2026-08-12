import { EthAddress } from '@dcl/crypto'
import { AppComponents } from '../../types'
import {
  InvalidWorldError,
  InvalidAccessError,
  SceneNotFoundError,
  WorldAtCapacityError,
  UserDenylistedError,
  UserBannedFromWorldError,
  UserPlatformBannedError
} from './errors'
import { DEFAULT_MAX_USERS_PER_WORLD } from './constants'
import { ConnectionOptions, ICommsComponent } from './types'

export const createCommsComponent = async (
  components: Pick<
    AppComponents,
    'namePermissionChecker' | 'access' | 'worlds' | 'commsAdapter' | 'config' | 'denyList' | 'bans'
  >
): Promise<ICommsComponent> => {
  const { namePermissionChecker, access, worlds, commsAdapter, config, denyList, bans } = components
  const maxUsersPerWorld = (await config.getNumber('MAX_USERS_PER_WORLD')) ?? DEFAULT_MAX_USERS_PER_WORLD

  /**
   * Records the connection and rejects it when the address or its device is platform-banned.
   *
   * Both calls depend only on the identity and neither affects the other's outcome — a ban is
   * matched against previously recorded devices, not the one being reported now — so they run
   * concurrently and cost one round-trip. Recording is best-effort and never throws, mirroring
   * how the comms-gatekeeper treats it on its own token paths.
   */
  async function assertConnectionAllowed(userAddress: EthAddress, options?: ConnectionOptions): Promise<void> {
    // Guarded here as well as inside the adapter: Promise.all rejects as a unit, so an
    // unexpected throw from recording would otherwise turn a bookkeeping failure into a refused
    // connection for a legitimate player. Awaited inside try/catch rather than chained off the
    // call so the guard holds even if recording ever returns something that is not a promise.
    async function recordConnection(): Promise<void> {
      try {
        await bans.recordPlayerConnection(userAddress, {
          deviceId: options?.deviceId,
          ipAddress: options?.ipAddress
        })
      } catch {
        // Best-effort: the adapter already logs, and this must never gate the connection.
      }
    }

    const [, isBanned] = await Promise.all([recordConnection(), bans.isPlayerBanned(userAddress, options?.deviceId)])

    if (isBanned) {
      throw new UserPlatformBannedError()
    }
  }

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
    connectionOptions?: ConnectionOptions
  ): Promise<string> {
    await assertConnectionAllowed(userAddress, connectionOptions)
    await assertUserNotDenylisted(userAddress)
    await assertWorldAccess(userAddress, worldName, connectionOptions)

    const sceneBaseParcel = await worlds.getWorldSceneBaseParcelIncludingUndeployed(worldName, sceneId)
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
    connectionOptions?: ConnectionOptions
  ): Promise<string> {
    await assertConnectionAllowed(userAddress, connectionOptions)
    await assertUserNotDenylisted(userAddress)
    await assertWorldAccess(userAddress, worldName, connectionOptions)

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
