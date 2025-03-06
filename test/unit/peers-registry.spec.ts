import { createPeersRegistry } from '../../src/adapters/peers-registry'
import { IPeersRegistry } from '../../src/types'

describe('PeersRegistry', () => {
  let peersRegistry: IPeersRegistry

  beforeEach(async () => {
    peersRegistry = await createPeersRegistry()
  })

  it('should track connected peers', async () => {
    peersRegistry.onPeerConnected('peer1', 'world1')
    expect(peersRegistry.getPeerWorld('peer1')).toBe('world1')
  })

  it('should track connected peers with lowercase ids', async () => {
    peersRegistry.onPeerConnected('PEER1', 'world1')
    expect(peersRegistry.getPeerWorld('peer1')).toBe('world1')
  })

  it('should remove disconnected peers', async () => {
    peersRegistry.onPeerConnected('peer1', 'world1')
    peersRegistry.onPeerDisconnected('peer1')
    expect(peersRegistry.getPeerWorld('peer1')).toBeUndefined()
  })

  it('should track connected peers with lowercase ids', async () => {
    peersRegistry.onPeerConnected('PEER1', 'world1')
    expect(peersRegistry.getPeerWorld('peer1')).toBe('world1')
  })

  it('should update peer world on reconnection', async () => {
    peersRegistry.onPeerConnected('peer1', 'world1')
    peersRegistry.onPeerConnected('peer1', 'world2')
    expect(peersRegistry.getPeerWorld('peer1')).toBe('world2')
  })

  it('should handle multiple peers', async () => {
    peersRegistry.onPeerConnected('peer1', 'world1')
    peersRegistry.onPeerConnected('peer2', 'world2')

    expect(peersRegistry.getPeerWorld('peer1')).toBe('world1')
    expect(peersRegistry.getPeerWorld('peer2')).toBe('world2')
  })
})
