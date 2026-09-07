import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import { livekitWebhookHandler } from '../../src/controllers/handlers/livekit-webhook-handler'
import { HandlerContextWithPath, IPeersRegistry, LivekitClient } from '../../src/types'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockLivekitClient } from '../mocks/livekit-client-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { createMockNatsComponent } from '../mocks/nats-mock'
import { createMockPeersRegistry } from '../mocks/peers-registry-mock'

type HandlerContext = HandlerContextWithPath<
  'config' | 'nats' | 'logs' | 'livekitClient' | 'peersRegistry',
  '/livekit-webhook'
> &
  DecentralandSignatureContext<any>

describe('livekitWebhookHandler', () => {
  let config: ReturnType<typeof createMockedConfig>
  let nats: jest.Mocked<INatsComponent>
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
      components: { config, nats, logs: createMockLogs(), livekitClient, peersRegistry },
      request: {
        text: async () => '{}',
        headers: new Headers({ Authorization: 'valid-auth-token' })
      }
    } as unknown as HandlerContext
  }

  beforeEach(() => {
    config = createMockedConfig()
    config.getString.mockResolvedValue(undefined)
    nats = createMockNatsComponent()
    peersRegistry = createMockPeersRegistry()
  })

  describe('when PUBLISH_PEER_WORLD_EVENTS is not configured', () => {
    it('should publish the join event, as it does today', async () => {
      await livekitWebhookHandler(contextFor('participant_joined'))

      expect(nats.publish).toHaveBeenCalledWith('peer.0x0000000000000000000000000000000000000003.world.join')
    })

    it('should publish the leave event, as it does today', async () => {
      await livekitWebhookHandler(contextFor('participant_left'))

      expect(nats.publish).toHaveBeenCalledWith('peer.0x0000000000000000000000000000000000000003.world.leave')
    })

    it('should register the peer in the registry', async () => {
      await livekitWebhookHandler(contextFor('participant_joined'))

      expect(peersRegistry.onPeerConnected).toHaveBeenCalledWith(
        '0x0000000000000000000000000000000000000003',
        'cozyfarm.dcl.eth'
      )
    })
  })

  describe('when PUBLISH_PEER_WORLD_EVENTS is false', () => {
    beforeEach(() => {
      config.getString.mockImplementation(async (name: string) =>
        name === 'PUBLISH_PEER_WORLD_EVENTS' ? 'false' : undefined
      )
    })

    it('should not publish the join event', async () => {
      await livekitWebhookHandler(contextFor('participant_joined'))

      expect(nats.publish).not.toHaveBeenCalled()
    })

    it('should not publish the leave event', async () => {
      await livekitWebhookHandler(contextFor('participant_left'))

      expect(nats.publish).not.toHaveBeenCalled()
    })

    it('should still register the peer in the registry', async () => {
      await livekitWebhookHandler(contextFor('participant_joined'))

      expect(peersRegistry.onPeerConnected).toHaveBeenCalledWith(
        '0x0000000000000000000000000000000000000003',
        'cozyfarm.dcl.eth'
      )
    })

    it('should still unregister the peer in the registry', async () => {
      await livekitWebhookHandler(contextFor('participant_left'))

      expect(peersRegistry.onPeerDisconnected).toHaveBeenCalledWith(
        '0x0000000000000000000000000000000000000003',
        'cozyfarm.dcl.eth'
      )
    })
  })

  describe('when PUBLISH_PEER_WORLD_EVENTS is true', () => {
    it('should publish the event', async () => {
      config.getString.mockImplementation(async (name: string) =>
        name === 'PUBLISH_PEER_WORLD_EVENTS' ? 'true' : undefined
      )

      await livekitWebhookHandler(contextFor('participant_joined'))

      expect(nats.publish).toHaveBeenCalledWith('peer.0x0000000000000000000000000000000000000003.world.join')
    })
  })
})
