import { createPeersRegistry } from '../../src/adapters/peers-registry'
import { IPeersRegistry } from '../../src/types'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IConfigComponent } from '@well-known-components/interfaces'

describe('PeersRegistry', () => {
  let peersRegistry: IPeersRegistry
  let config: IConfigComponent

  beforeEach(async () => {
    config = createConfigComponent({
      COMMS_ROOM_PREFIX: 'world-',
      SCENE_ROOM_PREFIX: 'world-scene-room-'
    })
    peersRegistry = await createPeersRegistry({ config })
  })

  describe('when a peer connects', () => {
    it('should track the peer in the world extracted from the comms room', () => {
      peersRegistry.onPeerConnected('0xalice', 'world-name.dcl.eth')
      expect(peersRegistry.getPeerWorld('0xalice')).toBe('name.dcl.eth')
    })

    it('should track the peer in the world extracted from the scene room', () => {
      peersRegistry.onPeerConnected('0xalice', 'world-scene-room-name.dcl.eth-scene1')
      expect(peersRegistry.getPeerWorld('0xalice')).toBe('name.dcl.eth')
    })

    it('should normalize identity to lowercase', () => {
      peersRegistry.onPeerConnected('0xALICE', 'world-name.dcl.eth')
      expect(peersRegistry.getPeerWorld('0xalice')).toBe('name.dcl.eth')
    })

    it('should use the full name when no prefix matches', () => {
      peersRegistry.onPeerConnected('0xalice', 'name.dcl.eth')
      expect(peersRegistry.getPeerWorld('0xalice')).toBe('name.dcl.eth')
    })

    it('should move the peer when they connect to a different world', () => {
      peersRegistry.onPeerConnected('0xalice', 'world-first.dcl.eth')
      peersRegistry.onPeerConnected('0xalice', 'world-second.dcl.eth')

      expect(peersRegistry.getPeerWorld('0xalice')).toBe('second.dcl.eth')
      expect(peersRegistry.getPeersInWorld('first.dcl.eth')).toEqual([])
      expect(peersRegistry.getPeersInWorld('second.dcl.eth')).toEqual(['0xalice'])
    })
  })

  describe('when a peer disconnects', () => {
    it('should remove the peer', () => {
      peersRegistry.onPeerConnected('0xalice', 'world-name.dcl.eth')
      peersRegistry.onPeerDisconnected('0xalice', 'world-name.dcl.eth')

      expect(peersRegistry.getPeerWorld('0xalice')).toBeUndefined()
      expect(peersRegistry.getPeersInWorld('name.dcl.eth')).toEqual([])
    })

    it('should handle case-insensitive identity', () => {
      peersRegistry.onPeerConnected('0xALICE', 'world-name.dcl.eth')
      peersRegistry.onPeerDisconnected('0xalice', 'world-name.dcl.eth')
      expect(peersRegistry.getPeerWorld('0xalice')).toBeUndefined()
    })

    it('should ignore stale disconnect from a previous world', () => {
      peersRegistry.onPeerConnected('0xalice', 'world-first.dcl.eth')
      peersRegistry.onPeerConnected('0xalice', 'world-second.dcl.eth')

      peersRegistry.onPeerDisconnected('0xalice', 'world-first.dcl.eth')

      expect(peersRegistry.getPeerWorld('0xalice')).toBe('second.dcl.eth')
      expect(peersRegistry.getPeersInWorld('second.dcl.eth')).toEqual(['0xalice'])
    })

    it('should ignore disconnect for unknown peer', () => {
      peersRegistry.onPeerDisconnected('0xunknown', 'world-name.dcl.eth')
      expect(peersRegistry.getPeerWorld('0xunknown')).toBeUndefined()
    })
  })

  describe('when getting peers in a world', () => {
    it('should return all peers in the world', () => {
      peersRegistry.onPeerConnected('0xalice', 'world-name.dcl.eth')
      peersRegistry.onPeerConnected('0xbob', 'world-name.dcl.eth')
      peersRegistry.onPeerConnected('0xcarol', 'world-other.dcl.eth')

      const peers = peersRegistry.getPeersInWorld('name.dcl.eth')
      expect(peers).toHaveLength(2)
      expect(peers).toContain('0xalice')
      expect(peers).toContain('0xbob')
    })

    it('should include peers from both comms and scene rooms of the same world', () => {
      peersRegistry.onPeerConnected('0xalice', 'world-name.dcl.eth')
      peersRegistry.onPeerConnected('0xbob', 'world-scene-room-name.dcl.eth-scene1')

      const peers = peersRegistry.getPeersInWorld('name.dcl.eth')
      expect(peers).toHaveLength(2)
      expect(peers).toContain('0xalice')
      expect(peers).toContain('0xbob')
    })

    it('should be case-insensitive', () => {
      peersRegistry.onPeerConnected('0xalice', 'world-Name.dcl.eth')

      expect(peersRegistry.getPeersInWorld('name.dcl.eth')).toContain('0xalice')
      expect(peersRegistry.getPeersInWorld('NAME.DCL.ETH')).toContain('0xalice')
    })

    it('should return empty array when no peers are in the world', () => {
      expect(peersRegistry.getPeersInWorld('name.dcl.eth')).toEqual([])
    })
  })
})
