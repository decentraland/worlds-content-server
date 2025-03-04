import { IPeersRegistry } from '../../src/types'

export function createMockPeersRegistry(): jest.Mocked<IPeersRegistry> {
  return {
    onPeerConnected: jest.fn(),
    onPeerDisconnected: jest.fn(),
    getPeerWorld: jest.fn()
  }
}
