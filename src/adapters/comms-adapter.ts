import { AppComponents, CommsStatus, ICommsAdapter, LivekitClient, WorldStatus } from '../types'
import { EthAddress } from '@dcl/schemas'
import { TrackSource, VideoGrant } from 'livekit-server-sdk'
import { LRUCache } from 'lru-cache'
import { fetchPulseRealms, getPresenceSource, PresenceSource } from '../logic/presence-source'

const STATUS_CACHE_TTL_MS = 60 * 1000

/** The `kind` label of `presence_shadow_diff` for the comparison behind `/live-data` and `/status`. */
const SHADOW_DIFF_KIND = 'live-data'

export async function createCommsAdapterComponent({
  config,
  fetch,
  logs,
  livekitClient,
  metrics
}: Pick<AppComponents, 'config' | 'fetch' | 'logs' | 'livekitClient' | 'metrics'>): Promise<ICommsAdapter> {
  const logger = logs.getLogger('comms-adapter')

  const worldRoomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const sceneRoomPrefix = await config.requireString('SCENE_ROOM_PREFIX')
  const adapterType = await config.requireString('COMMS_ADAPTER')

  const presenceSource = await getPresenceSource(config)
  // Only required once presence is (partly) read from Pulse, so the default source keeps the
  // service bootable with no new configuration at all.
  const pulseUrl = presenceSource === 'livekit' ? undefined : await config.requireString('PULSE_URL')

  switch (adapterType) {
    case 'ws-room': {
      const fixedAdapter = await config.requireString('COMMS_FIXED_ADAPTER')
      logger.info(`Using ws-room-service adapter with template baseUrl: ${fixedAdapter}`)
      return presenceSourcedAdapter(
        { fetch, logs, metrics },
        cachingAdapter({ logs }, createWsRoomAdapter({ fetch }, worldRoomPrefix, sceneRoomPrefix, fixedAdapter)),
        {
          presenceSource,
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
      return presenceSourcedAdapter(
        { fetch, logs, metrics },
        cachingAdapter({ logs }, createLiveKitAdapter({ logs }, worldRoomPrefix, sceneRoomPrefix, host, livekitClient)),
        {
          presenceSource,
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

type PresenceSourceOptions = {
  presenceSource: PresenceSource
  pulseUrl: string | undefined
  /** Kept verbatim from the transport: `adapterType`/`statusUrl` describe the transport, not the counter. */
  adapterType: string
  statusUrl: string
  /** Whether the transport publishes `CommsStatus.commitHash` — only ws-room does. */
  publishesCommitHash: boolean
}

/**
 * Iteration 2 (C4): re-sources `status()` — the counter behind `/live-data` and `/status.comms` —
 * from Pulse, leaving the published response shape untouched.
 *
 * The wrapper deliberately sits *outside* the transport adapter and overrides nothing else.
 * `getWorldRoomParticipantCount` / `getWorldSceneRoomsParticipantCount` back the
 * `MAX_USERS_PER_WORLD` capacity check and `removeParticipant` backs the kicks; both keep reading
 * LiveKit, which is the authority on who is attached to a room (iteration-2 exception: LiveKit is
 * the correct source there).
 *
 * With the default `PRESENCE_SOURCE=livekit` the transport adapter is returned untouched, so the
 * behaviour is identical to before this switch existed.
 */
function presenceSourcedAdapter(
  { fetch, logs, metrics }: Pick<AppComponents, 'fetch' | 'logs' | 'metrics'>,
  transportAdapter: ICommsAdapter,
  { presenceSource, pulseUrl, adapterType, statusUrl, publishesCommitHash }: PresenceSourceOptions
): ICommsAdapter {
  if (presenceSource === 'livekit' || !pulseUrl) {
    return transportAdapter
  }

  const logger = logs.getLogger('presence-sourced-comms-adapter')

  // `commitHash` describes the transport, exactly like `adapterType`/`statusUrl`, and Pulse cannot
  // supply it — so when the transport publishes one it is read from the transport (whose own status
  // is cached for the same TTL) rather than dropped, keeping the `/status` `comms` key set
  // identical under every presence source. Only needed while Pulse *is* the served answer: in
  // `both` the served answer is the transport's own and already carries it.
  const readTransportCommitHash = publishesCommitHash && presenceSource === 'pulse'

  function emptyStatus(): CommsStatus {
    return { adapterType, statusUrl, rooms: 0, users: 0, details: [], timestamp: Date.now() }
  }

  /** A transport outage drops the commit hash, never the Pulse-sourced answer. */
  async function transportCommitHash(): Promise<string | undefined> {
    if (!readTransportCommitHash) {
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
      fetchPulseRealms(fetch, pulseUrl!, logger),
      transportCommitHash()
    ])

    return {
      adapterType,
      statusUrl,
      // Spread, not assigned: a transport that publishes no commit hash must not gain the key.
      ...(readTransportCommitHash ? { commitHash } : {}),
      rooms: worlds.length,
      users: worlds.reduce((carry, world) => carry + world.users, 0),
      details: worlds,
      timestamp: lastUpdated
    }
  }

  /**
   * Counts how far the two sources disagree. Counts only: world membership is aggregated per world
   * and no wallet ever reaches the log or the metric.
   */
  function recordShadowDiff(livekitStatus: CommsStatus, pulse: CommsStatus): void {
    const livekitWorlds = new Map((livekitStatus.details ?? []).map((d) => [d.worldName.toLowerCase(), d.users]))
    const pulseWorlds = new Map((pulse.details ?? []).map((d) => [d.worldName.toLowerCase(), d.users]))

    let onlyInLivekit = 0
    let onlyInPulse = 0
    let worldsWithUserDelta = 0
    let totalUsersDelta = 0

    for (const [worldName, users] of livekitWorlds) {
      const pulseUsers = pulseWorlds.get(worldName)
      if (pulseUsers === undefined) {
        onlyInLivekit++
      } else if (pulseUsers !== users) {
        worldsWithUserDelta++
        totalUsersDelta += Math.abs(pulseUsers - users)
      }
    }
    for (const worldName of pulseWorlds.keys()) {
      if (!livekitWorlds.has(worldName)) {
        onlyInPulse++
      }
    }

    metrics.increment(
      'presence_shadow_diff',
      { kind: SHADOW_DIFF_KIND },
      onlyInLivekit + onlyInPulse + worldsWithUserDelta
    )

    logger.info('Presence shadow comparison', {
      kind: SHADOW_DIFF_KIND,
      onlyInLivekit,
      onlyInPulse,
      worldsWithUserDelta,
      totalUsersDelta,
      livekitWorlds: livekitWorlds.size,
      pulseWorlds: pulseWorlds.size,
      livekitUsers: livekitStatus.users,
      pulseUsers: pulse.users
    })
  }

  async function shadowedTransportStatus(): Promise<CommsStatus> {
    const [livekitStatus, pulse] = await Promise.all([
      // Typed as `CommsStatus`, but `cachingAdapter` hands back `undefined` when its very first
      // poll fails with nothing stale to fall back on. Guarding here keeps a transport outage from
      // turning into a comparison crash: the shadow is dropped, never the served answer.
      transportAdapter.status() as Promise<CommsStatus | undefined>,
      pulseStatus().catch((error: any) => {
        logger.warn(`Error retrieving the Pulse presence shadow: ${error.message}`)
        return undefined
      })
    ])

    if (livekitStatus && pulse) {
      recordShadowDiff(livekitStatus, pulse)
    }

    return livekitStatus as CommsStatus
  }

  // Mirrors the transport adapter's own cache so swapping the source does not change how often the
  // service is polled — and, in `both`, keeps the shadow comparison to one per TTL.
  const cache = new LRUCache<string, CommsStatus>({
    max: 1,
    ttl: STATUS_CACHE_TTL_MS,
    fetchMethod: async (_, staleValue): Promise<CommsStatus | undefined> => {
      try {
        return presenceSource === 'both' ? await shadowedTransportStatus() : await pulseStatus()
      } catch (error: any) {
        logger.warn(`Error retrieving comms status: ${error.message}`)
        return staleValue
      }
    }
  })

  return {
    ...transportAdapter,
    async status(): Promise<CommsStatus> {
      return (await cache.fetch('presence_status')) ?? emptyStatus()
    }
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
