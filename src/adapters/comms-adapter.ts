import { AppComponents, CommsStatus, ICommsAdapter, LivekitClient, WorldStatus } from '../types'
import { EthAddress } from '@dcl/schemas'
import { TrackSource, VideoGrant } from 'livekit-server-sdk'
import { LRUCache } from 'lru-cache'
import { fetchPulseRealms, PulseUnavailableError, requirePulseUrl } from '../logic/pulse'

export const STATUS_CACHE_TTL_MS = 60 * 1000

export async function createCommsAdapterComponent({
  config,
  fetch,
  logs,
  livekitClient
}: Pick<AppComponents, 'config' | 'fetch' | 'logs' | 'livekitClient' | 'metrics'>): Promise<ICommsAdapter> {
  const logger = logs.getLogger('comms-adapter')

  const worldRoomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const sceneRoomPrefix = await config.requireString('SCENE_ROOM_PREFIX')
  const adapterType = await config.requireString('COMMS_ADAPTER')

  // Iteration 2: Pulse is the only source of online-player counters, so it is required at boot —
  // there is no fallback left to degrade to. A malformed value fails here rather than surfacing as
  // a confusing fetch failure the first time a request needs it.
  const pulseUrl = await requirePulseUrl(config)

  switch (adapterType) {
    case 'ws-room': {
      const fixedAdapter = await config.requireString('COMMS_FIXED_ADAPTER')
      logger.info(`Using ws-room-service adapter with template baseUrl: ${fixedAdapter}`)
      return pulseSourcedAdapter(
        { fetch, logs },
        cachingAdapter({ logs }, createWsRoomAdapter({ fetch }, worldRoomPrefix, sceneRoomPrefix, fixedAdapter)),
        {
          pulseUrl,
          adapterType: 'ws-room',
          statusUrl: getWsRoomStatusUrl(fixedAdapter),
          publishesCommitHash: true
        }
      )
    }

    case 'livekit': {
      const host = await config.requireString('LIVEKIT_HOST')
      logger.info(`Using livekit adapter with host: ${host}`)
      return pulseSourcedAdapter(
        { fetch, logs },
        cachingAdapter({ logs }, createLiveKitAdapter({ logs }, worldRoomPrefix, sceneRoomPrefix, host, livekitClient)),
        {
          pulseUrl,
          adapterType: 'livekit',
          statusUrl: getLivekitStatusUrl(host),
          publishesCommitHash: false
        }
      )
    }

    default:
      throw Error(`Invalid comms adapter: ${adapterType}`)
  }
}

function createWsRoomAdapter(
  { fetch }: Pick<AppComponents, 'fetch'>,
  worldRoomPrefix: string,
  sceneRoomPrefix: string,
  fixedAdapter: string
): ICommsAdapter {
  const adapter: ICommsAdapter = {
    async status(): Promise<CommsStatus> {
      const statusUrl = getWsRoomStatusUrl(fixedAdapter)

      return await fetch
        .fetch(statusUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        })
        .then((response) => response.json())
        .then((res: any): CommsStatus => {
          const details: WorldStatus[] = res.details
            .filter(
              (room: any) =>
                room.roomName.startsWith(worldRoomPrefix) &&
                !room.roomName.startsWith(sceneRoomPrefix) &&
                room.count > 0
            )
            .map((room: { roomName: string; count: number }): WorldStatus => {
              const { roomName, count } = room
              return { worldName: roomName.substring(worldRoomPrefix.length), users: count }
            })
          return {
            adapterType: 'ws-room',
            statusUrl,
            commitHash: res.commitHash,
            rooms: details.length,
            users: details.reduce((carry, value) => carry + value.users, 0),
            details,
            timestamp: Date.now()
          }
        })
    },
    async getWorldRoomConnectionString(_userId: EthAddress, worldName: string): Promise<string> {
      const roomsUrl = fixedAdapter.replace(/rooms\/.*/, 'rooms')
      const roomId = `${worldRoomPrefix}${worldName.toLowerCase()}`
      return `${roomsUrl}/${roomId}`
    },
    async getSceneRoomConnectionString(_userId: EthAddress, worldName: string, sceneId: string): Promise<string> {
      const roomsUrl = fixedAdapter.replace(/rooms\/.*/, 'rooms')
      const roomId = `${sceneRoomPrefix}${worldName.toLowerCase()}-${sceneId.toLowerCase()}`
      return `${roomsUrl}/${roomId}`
    },
    async getWorldRoomParticipantCount(worldName: string): Promise<number> {
      const s = await adapter.status()
      const normalized = worldName.toLowerCase()
      const detail = s.details?.find((d) => d.worldName.toLowerCase() === normalized)
      return detail?.users ?? 0
    },
    async getWorldSceneRoomsParticipantCount(worldName: string): Promise<number> {
      const statusUrl = getWsRoomStatusUrl(fixedAdapter)
      const res = await fetch
        .fetch(statusUrl, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        })
        .then((response) => response.json())
      const normalized = worldName.toLowerCase()
      const sceneRoomPrefixForWorld = `${sceneRoomPrefix}${normalized}-`
      const details = (res.details ?? []) as { roomName: string; count: number }[]
      return details
        .filter((d) => d.roomName.startsWith(sceneRoomPrefixForWorld))
        .reduce((sum, d) => sum + (d.count ?? 0), 0)
    },
    async removeParticipant(_roomName: string, _identity: string): Promise<void> {
      // No-op for ws-room adapter
    }
  }
  return adapter
}

function createLiveKitAdapter(
  { logs }: Pick<AppComponents, 'logs'>,
  worldRoomPrefix: string,
  sceneRoomPrefix: string,
  host: string,
  livekitClient: LivekitClient
): ICommsAdapter {
  const logger = logs.getLogger('livekit-adapter')

  function buildWorldRoomGrant(roomId: string): VideoGrant {
    return {
      roomJoin: true,
      room: roomId,
      roomList: false,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
      canPublishSources: [TrackSource.MICROPHONE]
    }
  }

  return {
    async status(): Promise<CommsStatus> {
      try {
        const roomsWithCounts = await livekitClient.listRoomsWithParticipantCounts({
          namePrefix: worldRoomPrefix
        })
        const roomsWithUsers: WorldStatus[] = roomsWithCounts
          .filter((room) => !room.name.startsWith(sceneRoomPrefix))
          .map((room) => ({
            worldName: room.name.substring(worldRoomPrefix.length),
            users: room.numParticipants
          }))
          .filter((room) => room.users > 0)

        return {
          adapterType: 'livekit',
          statusUrl: getLivekitStatusUrl(host),
          rooms: roomsWithUsers.length,
          users: roomsWithUsers.reduce((carry, value) => carry + value.users, 0),
          details: roomsWithUsers,
          timestamp: Date.now()
        }
      } catch (error) {
        logger.error(`Error retrieving comms status: ${(error as Error).message}`)
        return {
          adapterType: 'livekit',
          statusUrl: getLivekitStatusUrl(host),
          rooms: 0,
          users: 0,
          details: [],
          timestamp: Date.now()
        }
      }
    },

    async getWorldRoomConnectionString(userId: EthAddress, worldName: string): Promise<string> {
      const roomId = `${worldRoomPrefix}${worldName.toLowerCase()}`
      return livekitClient.createConnectionToken(userId.toLowerCase(), buildWorldRoomGrant(roomId))
    },

    async getSceneRoomConnectionString(userId: EthAddress, worldName: string, sceneId: string): Promise<string> {
      const roomId = `${sceneRoomPrefix}${worldName.toLowerCase()}-${sceneId.toLowerCase()}`
      return livekitClient.createConnectionToken(userId.toLowerCase(), buildWorldRoomGrant(roomId))
    },

    async getWorldRoomParticipantCount(worldName: string): Promise<number> {
      const roomId = `${worldRoomPrefix}${worldName.toLowerCase()}`
      const room = await livekitClient.getRoom(roomId)
      return room?.numParticipants ?? 0
    },
    async getWorldSceneRoomsParticipantCount(worldName: string): Promise<number> {
      try {
        const normalized = worldName.toLowerCase()
        const sceneRoomPrefixForWorld = `${sceneRoomPrefix}${normalized}-`
        const roomsWithCounts = await livekitClient.listRoomsWithParticipantCounts({
          namePrefix: sceneRoomPrefixForWorld
        })
        return roomsWithCounts.reduce((sum, room) => sum + room.numParticipants, 0)
      } catch (error) {
        logger.error(`Error retrieving world scene rooms participant count: ${(error as Error).message}`)
        return 0
      }
    },

    async removeParticipant(roomName: string, identity: string): Promise<void> {
      await livekitClient.removeParticipant(roomName, identity)
    }
  }
}

function getLivekitStatusUrl(host: string): string {
  const clientUrl = host.includes('://') ? host : `wss://${host}`
  const parsed = new URL(clientUrl)
  const protocol = parsed.protocol === 'ws:' ? 'http:' : 'https:'
  return `${protocol}//${parsed.host}/`
}

function getWsRoomStatusUrl(fixedAdapter: string): string {
  const url = fixedAdapter.substring(fixedAdapter.indexOf(':') + 1)
  const urlWithProtocol =
    !url.startsWith('ws:') && !url.startsWith('wss:') ? 'https://' + url : url.replace(/ws\[s]?:/, 'https')
  return urlWithProtocol.replace(/rooms\/.*/, 'status')
}

export type PulseSourcedAdapterOptions = {
  pulseUrl: string
  /** Kept verbatim from the transport: `adapterType`/`statusUrl` describe the transport, not the counter. */
  adapterType: string
  statusUrl: string
  /** Whether the transport publishes `CommsStatus.commitHash` — only ws-room does. */
  publishesCommitHash: boolean
}

/**
 * Iteration 2 (C4): re-sources `status()` — the counter behind `/live-data` and `/status.comms` —
 * from Pulse, leaving the published response shape untouched. There is no LiveKit fallback: Pulse
 * is the only presence source.
 *
 * The wrapper deliberately sits *outside* the transport adapter and overrides nothing else.
 * `getWorldRoomParticipantCount` / `getWorldSceneRoomsParticipantCount` back the
 * `MAX_USERS_PER_WORLD` capacity check and `removeParticipant` backs the kicks; each keeps reading
 * LiveKit, which is the authority on who is attached to a room (iteration-2 exception: LiveKit is
 * the correct source there).
 *
 * Failure mode (C4-no-fallback): a failed Pulse read serves the last successful answer for one more
 * cache TTL. Once that grace period elapses too, `status()` rejects with `PulseUnavailableError`
 * instead of inventing a count — the caller (`live-data-handler.ts`, `status-handler.ts`) maps that
 * to `503`, never to a LiveKit-derived number.
 */
export function pulseSourcedAdapter(
  { fetch, logs }: Pick<AppComponents, 'fetch' | 'logs'>,
  transportAdapter: ICommsAdapter,
  { pulseUrl, adapterType, statusUrl, publishesCommitHash }: PulseSourcedAdapterOptions
): ICommsAdapter {
  const logger = logs.getLogger('pulse-sourced-comms-adapter')

  /** A transport outage drops the commit hash, never the Pulse-sourced answer. */
  async function transportCommitHash(): Promise<string | undefined> {
    if (!publishesCommitHash) {
      return undefined
    }

    try {
      return (await transportAdapter.status())?.commitHash
    } catch (error: any) {
      logger.warn(`Error retrieving the transport commit hash: ${error.message}`)
      return undefined
    }
  }

  async function pulseStatus(): Promise<CommsStatus> {
    const [{ worlds, lastUpdated }, commitHash] = await Promise.all([
      fetchPulseRealms(fetch, pulseUrl, logger),
      transportCommitHash()
    ])

    return {
      adapterType,
      statusUrl,
      // Spread, not assigned: a transport that publishes no commit hash must not gain the key.
      ...(publishesCommitHash ? { commitHash } : {}),
      rooms: worlds.length,
      users: worlds.reduce((carry, world) => carry + world.users, 0),
      details: worlds,
      timestamp: lastUpdated
    }
  }

  // Explicit state rather than a generic LRU cache: the grace period has to be measured from the
  // last *successful* read, not reset every time a stale copy is handed out again, so `cachedAt`
  // only ever advances on a successful `pulseStatus()`. `pendingRead` folds concurrent callers
  // during a cache miss into the one Pulse read in flight, the same way the transport's own cache
  // does. `lastAttemptAt` is the outage throttle: it advances on *every* attempt (success or
  // failure), independently of `cachedAt`, so a Pulse outage that fails fast cannot turn every
  // request on these public, unthrottled routes into its own upstream call.
  let cachedStatus: CommsStatus | undefined
  let cachedAt = 0
  let lastAttemptAt = 0
  let pendingRead: Promise<CommsStatus> | undefined

  async function readThroughCache(): Promise<CommsStatus> {
    const now = Date.now()
    if (cachedStatus && now - cachedAt < STATUS_CACHE_TTL_MS) {
      return cachedStatus
    }

    if (pendingRead) {
      return pendingRead
    }

    // Outage throttle: once a read has been attempted, no new Pulse read starts until a full cache
    // TTL has passed since that attempt, however many requests arrive in between -- `pendingRead`
    // above only folds callers that are truly concurrent with an in-flight read, which does nothing
    // once Pulse starts failing fast. This deliberately never touches `cachedAt`, so the 2xTTL
    // staleness cap below is unaffected.
    if (now - lastAttemptAt < STATUS_CACHE_TTL_MS) {
      if (cachedStatus && now - cachedAt < STATUS_CACHE_TTL_MS * 2) {
        return cachedStatus
      }
      throw new PulseUnavailableError('Pulse presence is unavailable')
    }

    lastAttemptAt = now
    pendingRead = (async () => {
      try {
        const fresh = await pulseStatus()
        cachedStatus = fresh
        cachedAt = Date.now()
        return fresh
      } catch (error: any) {
        logger.warn(`Error retrieving comms status: ${error.message}`)

        // One extra TTL of grace, measured from the last good read: still stale-serves the last
        // successful answer, but never a LiveKit-derived one, and never indefinitely.
        if (cachedStatus && Date.now() - cachedAt < STATUS_CACHE_TTL_MS * 2) {
          return cachedStatus
        }

        throw new PulseUnavailableError('Pulse presence is unavailable')
      } finally {
        pendingRead = undefined
      }
    })()

    return pendingRead
  }

  return {
    ...transportAdapter,
    status: readThroughCache
  }
}

function cachingAdapter({ logs }: Pick<AppComponents, 'logs'>, wrappedAdapter: ICommsAdapter): ICommsAdapter {
  const logger = logs.getLogger('caching-comms-adapter')

  const CACHE_KEY = 'comms_status'
  const cache = new LRUCache<string, CommsStatus>({
    max: 1,
    ttl: 60 * 1000, // cache for 1 minute
    fetchMethod: async (_, staleValue): Promise<CommsStatus | undefined> => {
      try {
        return await wrappedAdapter.status()
      } catch (_: any) {
        logger.warn(`Error retrieving comms status: ${_.message}`)
        return staleValue
      }
    }
  })

  return {
    async status(): Promise<CommsStatus> {
      return (await cache.fetch(CACHE_KEY))!
    },

    getWorldRoomConnectionString(userId: EthAddress, worldName: string): Promise<string> {
      return wrappedAdapter.getWorldRoomConnectionString(userId, worldName)
    },

    getSceneRoomConnectionString(userId: EthAddress, worldName: string, sceneId: string): Promise<string> {
      return wrappedAdapter.getSceneRoomConnectionString(userId, worldName, sceneId)
    },

    async getWorldRoomParticipantCount(worldName: string): Promise<number> {
      const status = await cache.fetch(CACHE_KEY)
      const normalized = worldName.toLowerCase()
      const detail = status?.details?.find((d) => d.worldName.toLowerCase() === normalized)
      return detail?.users ?? 0
    },

    getWorldSceneRoomsParticipantCount(worldName: string): Promise<number> {
      return wrappedAdapter.getWorldSceneRoomsParticipantCount(worldName)
    },

    removeParticipant(roomName: string, identity: string): Promise<void> {
      return wrappedAdapter.removeParticipant(roomName, identity)
    }
  }
}
