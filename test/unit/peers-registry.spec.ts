import { createPeersRegistry } from '../../src/adapters/peers-registry'
import { IPeersRegistry } from '../../src/types'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IConfigComponent } from '@well-known-components/interfaces'

describe('PeersRegistry', () => {
  let peersRegistry: IPeersRegistry
  let config: IConfigComponent

  beforeEach(async () => {
    config = createConfigComponent({ COMMS_ROOM_PREFIX: 'world-test-' })
    peersRegistry = await createPeersRegistry({ config })
  })

  describe('when a peer connects', () => {
    it('should track connected peers with room name as world', () => {
      peersRegistry.onPeerConnected('peer1', 'world1')
      expect(peersRegistry.getPeerWorld('peer1')).toBe('world1')
    })

    it('should track connected peers with lowercase ids', () => {
      peersRegistry.onPeerConnected('PEER1', 'world1')
      expect(peersRegistry.getPeerWorld('peer1')).toBe('world1')
    })

    it('should strip room prefix from room name when present', () => {
      peersRegistry.onPeerConnected('peer1', 'world-test-myworld')
      expect(peersRegistry.getPeerWorld('peer1')).toBe('myworld')
    })

    it('should keep full room name when prefix is not present', () => {
      peersRegistry.onPeerConnected('peer1', 'myworld')
      expect(peersRegistry.getPeerWorld('peer1')).toBe('myworld')
    })

    it('should handle room names that start with prefix but have additional content', () => {
      peersRegistry.onPeerConnected('peer1', 'world-test-complex-world-name')
      expect(peersRegistry.getPeerWorld('peer1')).toBe('complex-world-name')
    })

    it('should handle multiple peers with different room formats', () => {
      peersRegistry.onPeerConnected('peer1', 'world-test-world1')
      peersRegistry.onPeerConnected('peer2', 'world2')
      peersRegistry.onPeerConnected('peer3', 'world-test-complex-name')

      expect(peersRegistry.getPeerWorld('peer1')).toBe('world1')
      expect(peersRegistry.getPeerWorld('peer2')).toBe('world2')
      expect(peersRegistry.getPeerWorld('peer3')).toBe('complex-name')
    })
  })

  describe('when a peer disconnects', () => {
    it('should remove disconnected peers', () => {
      peersRegistry.onPeerConnected('peer1', 'world1')
      peersRegistry.onPeerDisconnected('peer1')
      expect(peersRegistry.getPeerWorld('peer1')).toBeUndefined()
    })

    it('should handle case insensitive peer disconnection', () => {
      peersRegistry.onPeerConnected('PEER1', 'world1')
      peersRegistry.onPeerDisconnected('peer1')
      expect(peersRegistry.getPeerWorld('peer1')).toBeUndefined()
    })
  })

  describe('when a peer reconnects', () => {
    it('should update peer world on reconnection', () => {
      peersRegistry.onPeerConnected('peer1', 'world1')
      peersRegistry.onPeerConnected('peer1', 'world2')
      expect(peersRegistry.getPeerWorld('peer1')).toBe('world2')
    })

    it('should update peer world with prefix stripping on reconnection', () => {
      peersRegistry.onPeerConnected('peer1', 'world1')
      peersRegistry.onPeerConnected('peer1', 'world-test-new-world')
      expect(peersRegistry.getPeerWorld('peer1')).toBe('new-world')
    })
  })

  describe('when querying peer world', () => {
    it('should return undefined for unknown peer', () => {
      expect(peersRegistry.getPeerWorld('unknown')).toBeUndefined()
    })

    it('should handle case insensitive queries', () => {
      peersRegistry.onPeerConnected('PEER1', 'world1')
      expect(peersRegistry.getPeerWorld('peer1')).toBe('world1')
      expect(peersRegistry.getPeerWorld('PEER1')).toBe('world1')
    })
  })
})
