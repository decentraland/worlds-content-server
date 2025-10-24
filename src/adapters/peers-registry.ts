import { AppComponents, IPeersRegistry } from '../types'

export async function createPeersRegistry({ config }: Pick<AppComponents, 'config'>): Promise<IPeersRegistry> {
  const roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const connectedPeers = new Map<string, string>()

  function onPeerConnected(id: string, roomName: string): void {
    const world = roomName.startsWith(roomPrefix) ? roomName.substring(roomPrefix.length) : roomName
    connectedPeers.set(id.toLowerCase(), world)
  }

  function onPeerDisconnected(id: string): void {
    connectedPeers.delete(id.toLowerCase())
  }

  function getPeerWorld(id: string): string | undefined {
    return connectedPeers.get(id.toLowerCase())
  }

  return {
    onPeerConnected,
    onPeerDisconnected,
    getPeerWorld
  }
}
