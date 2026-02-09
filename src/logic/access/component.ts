import { AppComponents } from '../../types'
import { AccessInput, AccessSetting, AccessType, IAccessComponent } from './types'
import { EthAddress } from '@dcl/schemas'
import bcrypt from 'bcrypt'
import { defaultAccess, DEFAULT_MAX_COMMUNITIES, DEFAULT_MAX_WALLETS, SALT_ROUNDS } from './constants'
import {
  InvalidAccessTypeError,
  InvalidAllowListSettingError,
  NotAllowListAccessError,
  UnauthorizedCommunityError
} from './errors'
import { ISocialServiceComponent } from '../../adapters/social-service'

type CheckingFunction = (ethAddress: EthAddress, extras?: any) => Promise<boolean>

function createUnrestrictedChecker(): CheckingFunction {
  return (_ethAddress: EthAddress, _extras?: any): Promise<boolean> => {
    return Promise.resolve(true)
  }
}

function createSharedSecretChecker(hashedSharedSecret: string): CheckingFunction {
  return (_ethAddress: EthAddress, plainTextSecret: string): Promise<boolean> => {
    return bcrypt.compare(plainTextSecret, hashedSharedSecret)
  }
}

function createNftOwnershipChecker(_requiredNft: string): CheckingFunction {
  return (_ethAddress: EthAddress): Promise<boolean> => {
    // TODO Check NFT ownership in the blockchain
    return Promise.resolve(false)
  }
}

/**
 * Creates an allow-list checker factory that captures the socialService dependency.
 * This avoids passing socialService through multiple layers.
 */
function createAllowListCheckerFactory(socialService: ISocialServiceComponent) {
  return (allowList: string[], communities: string[]): CheckingFunction => {
    const lowerCasedAllowList = allowList.map((ethAddress) => ethAddress.toLowerCase())

    return async (ethAddress: EthAddress, _extras?: any): Promise<boolean> => {
      // Check wallets first (faster, local)
      if (lowerCasedAllowList.includes(ethAddress.toLowerCase())) {
        return true
      }

      // Check communities if defined (batch check)
      if (communities.length > 0) {
        const { communities: memberCommunities } = await socialService.getMemberCommunities(ethAddress, communities)
        return memberCommunities.length > 0
      }

      return false
    }
  }
}

export async function createAccessComponent({
  config,
  socialService,
  worldsManager,
  peersRegistry,
  commsAdapter,
  logs
}: Pick<
  AppComponents,
  'config' | 'socialService' | 'worldsManager' | 'peersRegistry' | 'commsAdapter' | 'logs'
>): Promise<IAccessComponent> {
  const logger = logs.getLogger('access-component')
  const maxCommunities = (await config.getNumber('ACCESS_MAX_COMMUNITIES')) ?? DEFAULT_MAX_COMMUNITIES
  const maxWallets = (await config.getNumber('ACCESS_MAX_WALLETS')) ?? DEFAULT_MAX_WALLETS
  const kickBatchSize = (await config.getNumber('ACCESS_KICK_BATCH_SIZE')) ?? 20

  const createAllowListChecker = createAllowListCheckerFactory(socialService)

  /**
   * State-based kick policy that determines which participants should be kicked
   * based on the transition between access types.
   *
   * Design Pattern: State Transition Matrix
   * - Each transition is explicitly modeled
   * - Clear separation between "kick all" vs "kick unauthorized only"
   * - Handles edge cases (same type transitions, unrestricted targets)
   */
  type KickPolicy = {
    shouldKickAll: boolean
    shouldCheckIndividualAccess: boolean
  }

  function determineKickPolicy(previousType: AccessType, newType: AccessType): KickPolicy {
    // Unrestricted target → no kicks needed (opening access)
    if (newType === AccessType.Unrestricted) {
      return { shouldKickAll: false, shouldCheckIndividualAccess: false }
    }

    // Same type transitions
    if (previousType === newType) {
      if (newType === AccessType.SharedSecret) {
        // Secret may have changed → kick all
        return { shouldKickAll: true, shouldCheckIndividualAccess: false }
      }
      if (newType === AccessType.AllowList) {
        // AllowList → AllowList: kick only those not in new list
        return { shouldKickAll: false, shouldCheckIndividualAccess: true }
      }
      // Unrestricted → Unrestricted or NFT → NFT: no kicks
      return { shouldKickAll: false, shouldCheckIndividualAccess: false }
    }

    // Transitions FROM Unrestricted TO restricted types
    if (previousType === AccessType.Unrestricted) {
      if (newType === AccessType.AllowList) {
        // Check individual access (some may be in list)
        return { shouldKickAll: false, shouldCheckIndividualAccess: true }
      }
      // TO SharedSecret or NFTOwnership: kick all
      return { shouldKickAll: true, shouldCheckIndividualAccess: false }
    }

    // Transitions TO AllowList from SharedSecret/NFTOwnership: check individual access
    if (newType === AccessType.AllowList) {
      return { shouldKickAll: false, shouldCheckIndividualAccess: true }
    }

    // All other transitions (TO SharedSecret or NFTOwnership from restricted types): kick all
    return { shouldKickAll: true, shouldCheckIndividualAccess: false }
  }

  /**
   * Kicks participants in batches to avoid unbounded parallelism.
   * Uses Promise.allSettled to ensure all kick attempts are made even if some fail.
   * Kicks from ALL rooms the participant is in (both world room and scene rooms).
   */
  async function kickParticipantsInBatches(worldName: string, identities: string[]): Promise<void> {
    if (identities.length === 0) {
      return
    }

    logger.info(`Kicking ${identities.length} participant(s) from world ${worldName}`, {
      worldName,
      participantCount: identities.length
    })

    for (let i = 0; i < identities.length; i += kickBatchSize) {
      const batch = identities.slice(i, i + kickBatchSize)
      const results = await Promise.allSettled(
        batch.map(async (identity) => {
          // Get all rooms this peer is in (comms + scene rooms)
          const rooms = peersRegistry.getPeerRooms(identity)

          if (rooms.length === 0) {
            logger.debug(`Peer not in any rooms, skipping`, {
              worldName,
              identity
            })
            return
          }

          // Kick from all rooms
          const kickResults = await Promise.allSettled(
            rooms.map(async (roomName) => {
              try {
                await commsAdapter.removeParticipant(roomName, identity)
                logger.debug(`Kicked participant from room`, {
                  worldName,
                  roomName,
                  identity
                })
              } catch (error) {
                logger.warn(`Failed to kick participant from room`, {
                  worldName,
                  roomName,
                  identity,
                  error: error instanceof Error ? error.message : String(error)
                })
                throw error
              }
            })
          )

          const kickFailures = kickResults.filter((r) => r.status === 'rejected')
          if (kickFailures.length > 0) {
            logger.warn(`Failed to kick participant from ${kickFailures.length}/${rooms.length} room(s)`, {
              worldName,
              identity,
              totalRooms: rooms.length,
              failedRooms: kickFailures.length
            })
            throw new Error(`Failed to kick from ${kickFailures.length} room(s)`)
          }
        })
      )

      const failures = results.filter((r) => r.status === 'rejected')
      if (failures.length > 0) {
        logger.warn(`Batch completed with ${failures.length} failure(s)`, {
          worldName,
          batchSize: batch.length,
          failures: failures.length
        })
      }
    }

    logger.info(`Completed kicking participants from world ${worldName}`, {
      worldName,
      totalKicked: identities.length
    })
  }

  /**
   * Enforces access control after settings change by kicking unauthorized participants.
   * Implements the state transition matrix for determining kick policy.
   */
  async function enforceAccessAfterChange(
    worldName: string,
    previousAccess: AccessSetting,
    newAccess: AccessSetting
  ): Promise<void> {
    const policy = determineKickPolicy(previousAccess.type, newAccess.type)

    // No kicks needed
    if (!policy.shouldKickAll && !policy.shouldCheckIndividualAccess) {
      logger.debug(`No kicks needed for access change`, {
        worldName,
        previousType: previousAccess.type,
        newType: newAccess.type
      })
      return
    }

    const identities = peersRegistry.getPeersInWorld(worldName)

    if (identities.length === 0) {
      logger.debug(`No participants in world, skipping kicks`, { worldName })
      return
    }

    if (policy.shouldKickAll) {
      logger.info(`Kicking all participants due to access type change`, {
        worldName,
        previousType: previousAccess.type,
        newType: newAccess.type,
        participantCount: identities.length
      })
      await kickParticipantsInBatches(worldName, identities)
      return
    }

    if (policy.shouldCheckIndividualAccess) {
      logger.info(`Checking individual access for participants`, {
        worldName,
        previousType: previousAccess.type,
        newType: newAccess.type,
        participantCount: identities.length
      })

      // Check each participant's access and collect those without access
      const unauthorizedIdentities: string[] = []
      for (const identity of identities) {
        try {
          const hasAccess = await checkAccess(worldName, identity as EthAddress)
          if (!hasAccess) {
            unauthorizedIdentities.push(identity)
          }
        } catch (error) {
          logger.warn(`Error checking access for participant, kicking as precaution`, {
            worldName,
            identity,
            error: error instanceof Error ? error.message : String(error)
          })
          // If we can't verify access, kick as a safety measure
          unauthorizedIdentities.push(identity)
        }
      }

      if (unauthorizedIdentities.length > 0) {
        logger.info(`Found ${unauthorizedIdentities.length} unauthorized participant(s)`, {
          worldName,
          total: identities.length,
          unauthorized: unauthorizedIdentities.length
        })
        await kickParticipantsInBatches(worldName, unauthorizedIdentities)
      } else {
        logger.debug(`All participants have valid access`, { worldName })
      }
    }
  }

  function createAccessCheckerFrom(accessSetting: AccessSetting): CheckingFunction {
    switch (accessSetting.type) {
      case AccessType.Unrestricted:
        return createUnrestrictedChecker()
      case AccessType.SharedSecret:
        return createSharedSecretChecker(accessSetting.secret)
      case AccessType.NFTOwnership:
        return createNftOwnershipChecker(accessSetting.nft)
      case AccessType.AllowList:
        return createAllowListChecker(accessSetting.wallets, accessSetting.communities)
      default:
        throw new Error(`Invalid access type.`)
    }
  }

  /**
   * Gets the access setting for a world using the faster getRawWorldRecords method.
   * Returns the default access (unrestricted) if the world doesn't exist or has no access defined.
   *
   * @param worldName - The name of the world
   * @returns The access setting for the world, or defaultAccess() if the world doesn't exist
   */
  async function getAccessForWorld(worldName: string): Promise<AccessSetting> {
    const { records } = await worldsManager.getRawWorldRecords({ worldName })
    if (records.length === 0) {
      return defaultAccess()
    }
    return records[0].access || defaultAccess()
  }

  async function checkAccess(worldName: string, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    const access = await getAccessForWorld(worldName)

    const accessChecker = createAccessCheckerFrom(access)
    return accessChecker(ethAddress, extras)
  }

  /**
   * Set access settings for a world with validation.
   * Validates the access type and constructs the appropriate AccessSetting.
   * For AllowList with communities, validates that the signer is a member of all communities.
   * After storing the new access, enforces the change by kicking unauthorized participants.
   */
  async function setAccess(worldName: string, signer: EthAddress, input: AccessInput): Promise<void> {
    const { type, wallets, communities, nft, secret } = input
    let accessSetting: AccessSetting

    // Capture previous access before making changes
    const previousAccess = await getAccessForWorld(worldName)

    switch (type) {
      case AccessType.AllowList: {
        if (communities && communities.length > maxCommunities) {
          throw new InvalidAllowListSettingError(
            `Too many communities. Maximum allowed is ${maxCommunities}, but ${communities.length} were provided.`
          )
        }

        if (wallets && wallets.length > maxWallets) {
          throw new InvalidAllowListSettingError(
            `Too many wallets in allow-list. Maximum allowed is ${maxWallets}, but ${wallets.length} were provided.`
          )
        }

        // Validate that the signer is a member of all communities they're trying to set
        if (communities && communities.length > 0) {
          const { communities: memberCommunities } = await socialService.getMemberCommunities(signer, communities)
          const memberCommunityIds = new Set(memberCommunities.map((c: { id: string }) => c.id))
          const unauthorizedCommunities = communities.filter((id) => !memberCommunityIds.has(id))

          if (unauthorizedCommunities.length > 0) {
            throw new UnauthorizedCommunityError(unauthorizedCommunities)
          }
        }

        accessSetting = {
          type: AccessType.AllowList,
          wallets: wallets || [],
          communities: communities || []
        }
        break
      }
      case AccessType.Unrestricted: {
        accessSetting = { type: AccessType.Unrestricted }
        break
      }
      case AccessType.NFTOwnership: {
        if (!nft) {
          throw new InvalidAccessTypeError('For nft ownership there needs to be a valid nft.')
        }
        accessSetting = { type: AccessType.NFTOwnership, nft }
        break
      }
      case AccessType.SharedSecret: {
        if (!secret) {
          throw new InvalidAccessTypeError('For shared secret there needs to be a valid secret.')
        }
        accessSetting = {
          type: AccessType.SharedSecret,
          secret: bcrypt.hashSync(secret, SALT_ROUNDS)
        }
        break
      }
      default: {
        throw new InvalidAccessTypeError(`Invalid access type: ${type}.`)
      }
    }

    await worldsManager.createBasicWorldIfNotExists(worldName, signer)
    await worldsManager.storeAccess(worldName, accessSetting)

    // Enforce the access change by kicking unauthorized participants
    try {
      await enforceAccessAfterChange(worldName, previousAccess, accessSetting)
    } catch (error) {
      // Log but don't fail the setAccess operation
      // The access settings have been stored successfully
      logger.error(`Error enforcing access change`, {
        worldName,
        previousType: previousAccess.type,
        newType: accessSetting.type,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Adds a wallet to the access allow-list for a world.
   * Ensures the world entry exists before modifying permissions.
   * The world must have allow-list access type for this operation to succeed.
   *
   * @param worldName - The name of the world
   * @param owner - The Ethereum address of the world owner
   * @param wallet - The wallet address to add to the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   */
  async function addWalletToAccessAllowList(worldName: string, owner: EthAddress, wallet: EthAddress): Promise<void> {
    await worldsManager.createBasicWorldIfNotExists(worldName, owner)

    const access = await getAccessForWorld(worldName)

    if (access.type !== AccessType.AllowList) {
      throw new NotAllowListAccessError(worldName)
    }

    const lowerWallet = wallet.toLowerCase()
    const existingWallets = access.wallets || []

    // Check if wallet is already in the list (case-insensitive)
    if (existingWallets.some((w) => w.toLowerCase() === lowerWallet)) {
      return // Already in the list, idempotent operation
    }

    const updatedWallets = [...existingWallets, lowerWallet]
    if (updatedWallets.length > maxWallets) {
      throw new InvalidAllowListSettingError(
        `Cannot add wallet: allow-list would exceed the maximum of ${maxWallets} wallets.`
      )
    }

    const updatedAccess: AccessSetting = {
      ...access,
      wallets: updatedWallets
    }

    await worldsManager.storeAccess(worldName, updatedAccess)
  }

  /**
   * Removes a wallet from the access allow-list for a world.
   * The world must have allow-list access type for this operation to succeed.
   *
   * @param worldName - The name of the world
   * @param wallet - The wallet address to remove from the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   */
  async function removeWalletFromAccessAllowList(worldName: string, wallet: EthAddress): Promise<void> {
    const access = await getAccessForWorld(worldName)

    if (access.type !== AccessType.AllowList) {
      throw new NotAllowListAccessError(worldName)
    }

    const lowerWallet = wallet.toLowerCase()
    const existingWallets = access.wallets || []

    // Filter out the wallet (case-insensitive)
    const updatedWallets = existingWallets.filter((w) => w.toLowerCase() !== lowerWallet)

    const updatedAccess: AccessSetting = {
      ...access,
      wallets: updatedWallets
    }

    await worldsManager.storeAccess(worldName, updatedAccess)
  }

  /**
   * Adds a community to the access allow-list for a world.
   * The world must have allow-list access type. The signer must be a member of the community.
   *
   * @param worldName - The name of the world
   * @param signer - The wallet adding the community (must be a member of the community)
   * @param communityId - The community id to add to the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   * @throws {UnauthorizedCommunityError} If the signer is not a member of the community
   */
  async function addCommunityToAccessAllowList(
    worldName: string,
    signer: EthAddress,
    communityId: string
  ): Promise<void> {
    const access = await getAccessForWorld(worldName)

    if (access.type !== AccessType.AllowList) {
      throw new NotAllowListAccessError(worldName)
    }

    const { communities: memberCommunities } = await socialService.getMemberCommunities(signer, [communityId])
    const isMember = memberCommunities.some((c: { id: string }) => c.id === communityId)
    if (!isMember) {
      throw new UnauthorizedCommunityError([communityId])
    }

    const existingCommunities = access.communities || []
    if (existingCommunities.includes(communityId)) {
      return
    }

    if (existingCommunities.length >= maxCommunities) {
      throw new InvalidAllowListSettingError(
        `Too many communities. Maximum allowed is ${maxCommunities}, cannot add more.`
      )
    }

    const updatedAccess: AccessSetting = {
      ...access,
      communities: [...existingCommunities, communityId]
    }

    await worldsManager.storeAccess(worldName, updatedAccess)
  }

  /**
   * Removes a community from the access allow-list for a world.
   * The world must have allow-list access type for this operation to succeed.
   *
   * @param worldName - The name of the world
   * @param communityId - The community id to remove from the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   */
  async function removeCommunityFromAccessAllowList(worldName: string, communityId: string): Promise<void> {
    const access = await getAccessForWorld(worldName)

    if (access.type !== AccessType.AllowList) {
      throw new NotAllowListAccessError(worldName)
    }

    const existingCommunities = access.communities || []
    const updatedCommunities = existingCommunities.filter((id) => id !== communityId)

    const updatedAccess: AccessSetting = {
      ...access,
      communities: updatedCommunities
    }

    await worldsManager.storeAccess(worldName, updatedAccess)
  }

  return {
    checkAccess,
    setAccess,
    addWalletToAccessAllowList,
    removeWalletFromAccessAllowList,
    addCommunityToAccessAllowList,
    removeCommunityFromAccessAllowList,
    getAccessForWorld
  }
}
