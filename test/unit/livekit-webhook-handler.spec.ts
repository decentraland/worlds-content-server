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

  // A Helm value is quite easily `FALSE`, `0` or `false ` with a trailing space. The flag is read
  // the same way `PRESENCE_SOURCE` is — trimmed and case-insensitive — so an operator flipping it
  // at rollout step 8 cannot leave the publish running while social-service-ea is already on
  // Pulse, which would deliver world join/leave twice.
  describe.each(['false', 'FALSE', 'False', '0', 'no', ' false '])(
    'when PUBLISH_PEER_WORLD_EVENTS is %p',
    (configured) => {
      beforeEach(() => {
        config.getString.mockImplementation(async (name: string) =>
          name === 'PUBLISH_PEER_WORLD_EVENTS' ? configured : undefined
        )
      })

      it('should not publish the join event', async () => {
        await livekitWebhookHandler(contextFor('participant_joined'))

        expect(nats.publish).not.toHaveBeenCalled()
      })

      it('should still register the peer in the registry', async () => {
        await livekitWebhookHandler(contextFor('participant_joined'))

        expect(peersRegistry.onPeerConnected).toHaveBeenCalledWith(
          '0x0000000000000000000000000000000000000003',
          'cozyfarm.dcl.eth'
        )
      })
    }
  )

  describe.each(['true', 'TRUE', ' true ', 'yes', '1', 'nonsense', ''])(
    'when PUBLISH_PEER_WORLD_EVENTS is %p',
    (configured) => {
      it('should keep publishing, because only an explicit off value disables it', async () => {
        config.getString.mockImplementation(async (name: string) =>
          name === 'PUBLISH_PEER_WORLD_EVENTS' ? configured : undefined
        )

        await livekitWebhookHandler(contextFor('participant_joined'))

        expect(nats.publish).toHaveBeenCalledWith('peer.0x0000000000000000000000000000000000000003.world.join')
      })
    }
  )

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
