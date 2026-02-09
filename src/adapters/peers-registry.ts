import { AppComponents, IPeersRegistry } from '../types'

const DCL_ETH_SUFFIX = '.dcl.eth'

export async function createPeersRegistry({ config }: Pick<AppComponents, 'config'>): Promise<IPeersRegistry> {
  const commsRoomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const sceneRoomPrefix = await config.requireString('SCENE_ROOM_PREFIX')

  const peerToWorld = new Map<string, string>()
  const worldToPeers = new Map<string, Set<string>>()

  /**
   * Extracts the base world name from a LiveKit room name.
   *
   * Room formats (from comms-adapter):
   *   Comms room: {COMMS_PREFIX}{worldName}
   *   Scene room: {SCENE_PREFIX}{worldName}-{sceneId}
   *
   * Scene prefix is checked first — it is a superset of the comms prefix.
   * For scene rooms the trailing "-{sceneId}" is discarded by locating the
   * ".dcl.eth" boundary in the stripped result.
   *
   * @param roomName - raw LiveKit room name (e.g. "comms-name.dcl.eth")
   * @returns base world name (e.g. "name.dcl.eth")
   */
  function extractWorldName(roomName: string): string {
    let stripped: string
    if (roomName.startsWith(sceneRoomPrefix)) {
      stripped = roomName.substring(sceneRoomPrefix.length)
    } else if (roomName.startsWith(commsRoomPrefix)) {
      stripped = roomName.substring(commsRoomPrefix.length)
    } else {
      stripped = roomName
    }

    const idx = stripped.indexOf(DCL_ETH_SUFFIX)
    if (idx !== -1) {
      return stripped.substring(0, idx + DCL_ETH_SUFFIX.length)
    }

    return stripped.toLowerCase()
  }

  function addToIndex(identity: string, world: string): void {
    let set = worldToPeers.get(world)
    if (!set) {
      set = new Set()
      worldToPeers.set(world, set)
    }
    set.add(identity)
  }

  function removeFromIndex(identity: string, world: string): void {
    const set = worldToPeers.get(world)
    if (!set) return
    set.delete(identity)
    if (set.size === 0) worldToPeers.delete(world)
  }

  /**
   * Registers a peer as connected to the world derived from the given room.
   * If the peer was already in a different world, it is moved atomically.
   *
   * @param id - peer identity (case-insensitive)
   * @param roomName - LiveKit room name the peer joined
   */
  function onPeerConnected(id: string, roomName: string): void {
    const identity = id.toLowerCase()
    const world = extractWorldName(roomName)

    const previous = peerToWorld.get(identity)
    if (previous !== undefined && previous !== world) {
      removeFromIndex(identity, previous)
    }

    peerToWorld.set(identity, world)
    addToIndex(identity, world)
  }

  /**
   * Unregisters a peer from the world derived from the given room.
   * Stale disconnects (peer already moved to another world) are ignored.
   *
   * @param id - peer identity (case-insensitive)
   * @param roomName - LiveKit room name the peer left
   */
  function onPeerDisconnected(id: string, roomName: string): void {
    const identity = id.toLowerCase()
    const world = extractWorldName(roomName)

    if (peerToWorld.get(identity) !== world) return

    peerToWorld.delete(identity)
    removeFromIndex(identity, world)
  }

  /**
   * @param id - peer identity (case-insensitive)
   * @returns the world the peer is in, or undefined if not connected
   */
  function getPeerWorld(id: string): string | undefined {
    return peerToWorld.get(id.toLowerCase())
  }

  /**
   * @param worldName - world name (e.g. "name.dcl.eth"), case-insensitive
   * @returns identities currently connected to that world
   */
  function getPeersInWorld(worldName: string): string[] {
    return Array.from(worldToPeers.get(worldName.toLowerCase()) ?? [])
  }

  return {
    onPeerConnected,
    onPeerDisconnected,
    getPeerWorld,
    getPeersInWorld
  }
}
