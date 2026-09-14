import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { livekitWebhookHandler } from '../../src/controllers/handlers/livekit-webhook-handler'
import { HandlerContextWithPath, IPeersRegistry, LivekitClient } from '../../src/types'
import { createMockLivekitClient } from '../mocks/livekit-client-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { createMockPeersRegistry } from '../mocks/peers-registry-mock'

type HandlerContext = HandlerContextWithPath<'logs' | 'livekitClient' | 'peersRegistry', '/livekit-webhook'> &
  DecentralandSignatureContext<any>

describe('livekitWebhookHandler', () => {
  let peersRegistry: jest.Mocked<IPeersRegistry>
  let livekitClient: LivekitClient

  function contextFor(event: string): HandlerContext {
    livekitClient = createMockLivekitClient({
      receiveWebhookEvent: jest.fn().mockResolvedValue({
        event,
        room: { name: 'cozyfarm.dcl.eth' },
        participant: { identity: '0x0000000000000000000000000000000000000003' }
      })
    })

    return {
      components: { logs: createMockLogs(), livekitClient, peersRegistry },
      request: {
        text: async () => '{}',
        headers: new Headers({ Authorization: 'valid-auth-token' })
      }
    } as unknown as HandlerContext
  }

  beforeEach(() => {
    peersRegistry = createMockPeersRegistry()
  })

  // Iteration 2: Pulse is the platform's only presence source, so this webhook no longer publishes
  // `peer.<identity>.world.join|leave` anywhere (social-service-ea reads Pulse's
  // `engine.parcel_changes` feed instead). The registry update is never gated.
  describe('when a participant joins', () => {
    it('should register the peer in the registry', async () => {
      await livekitWebhookHandler(contextFor('participant_joined'))

      expect(peersRegistry.onPeerConnected).toHaveBeenCalledWith(
        '0x0000000000000000000000000000000000000003',
        'cozyfarm.dcl.eth'
      )
    })
  })

  describe('when a participant leaves', () => {
    it('should unregister the peer in the registry', async () => {
      await livekitWebhookHandler(contextFor('participant_left'))

      expect(peersRegistry.onPeerDisconnected).toHaveBeenCalledWith(
        '0x0000000000000000000000000000000000000003',
        'cozyfarm.dcl.eth'
      )
    })
  })
})
