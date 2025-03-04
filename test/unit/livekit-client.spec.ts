import { WebhookEvent, WebhookReceiver } from 'livekit-server-sdk'
import { createLivekitClient } from '../../src/adapters/livekit-client'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { LivekitClient } from '../../src/types'

jest.mock('livekit-server-sdk')

describe('LivekitClient', () => {
  let config: IConfigComponent
  let livekitClient: LivekitClient

  beforeEach(async () => {
    config = createConfigComponent({
      LIVEKIT_API_KEY: 'test_api_key',
      LIVEKIT_API_SECRET: 'test_api_secret'
    })
    livekitClient = await createLivekitClient({ config })
  })

  it('should create a livekit client with correct configuration', async () => {
    expect(WebhookReceiver).toHaveBeenCalledWith('test_api_key', 'test_api_secret')
  })

  it('should receive webhook events correctly', async () => {
    const mockEvent = {
      event: 'participant_joined',
      participant: { identity: 'test' },
      room: { name: 'test' }
    } as WebhookEvent

    jest.spyOn(WebhookReceiver.prototype, 'receive').mockResolvedValue(mockEvent)

    const result = await livekitClient.receiveWebhookEvent('test-body', 'test-auth')

    expect(result).toEqual(mockEvent)
    expect(WebhookReceiver.prototype.receive).toHaveBeenCalledWith('test-body', 'test-auth')
  })
})
