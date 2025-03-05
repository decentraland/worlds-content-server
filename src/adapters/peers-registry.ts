import { IPeersRegistry } from '../types'

export async function createPeersRegistry(): Promise<IPeersRegistry> {
  const connectedPeers = new Map<string, string>()

  function onPeerConnected(id: string, world: string): void {
    connectedPeers.set(id, world)
  }

  function onPeerDisconnected(id: string): void {
    connectedPeers.delete(id)
  }

  function getPeerWorld(id: string): string | undefined {
    return connectedPeers.get(id)
  }

  return {
    onPeerConnected,
    onPeerDisconnected,
    getPeerWorld
  }
}
