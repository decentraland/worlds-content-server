import { AppComponents, IPeersRegistry } from '../types'

export async function createPeersRegistry({ config }: Pick<AppComponents, 'config'>): Promise<IPeersRegistry> {
  const commsRoomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const sceneRoomPrefix = await config.requireString('SCENE_ROOM_PREFIX')

  const connectedPeers = new Map<string, string>()

  function onPeerConnected(id: string, roomName: string): void {
    let world = roomName

    if (roomName.startsWith(sceneRoomPrefix)) {
      world = roomName.substring(sceneRoomPrefix.length)
    } else if (roomName.startsWith(commsRoomPrefix)) {
      world = roomName.substring(commsRoomPrefix.length)
    }
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
