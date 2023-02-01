import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createCommsAdapterComponent } from '../../src/adapters/comms-adapter'
import { createLogComponent } from '@well-known-components/logger'

describe('comms-adapter', function () {
  describe('ws-room', function () {
    it('resolves ws-room when well configured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'ws-room',
        COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene'
      })
      const logs = await createLogComponent({ config })

      const commsAdapter = await createCommsAdapterComponent({ config, logs })

      expect(await commsAdapter.connectionString('0xA', 'my-room')).toBe(
        'ws-room:ws-room-service.decentraland.org/rooms/my-room'
      )
    })

    it('refuses to initialize when misconfigured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'ws-room'
      })
      const logs = await createLogComponent({ config })

      await expect(createCommsAdapterComponent({ config, logs })).rejects.toThrow(
        'Configuration: string COMMS_FIXED_ADAPTER is required'
      )
    })
  })

  describe('livekit', function () {
    it('resolves ws-room when well configured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        LIVEKIT_HOST: 'wss://livekit.dcl.org',
        LIVEKIT_API_KEY: 'myApiKey',
        LIVEKIT_API_SECRET: 'myApiSecret'
      })
      const logs = await createLogComponent({ config })

      const commsAdapter = await createCommsAdapterComponent({ config, logs })

      const adapter = await commsAdapter.connectionString('0xA', 'my-room')
      expect(adapter).toContain('livekit:wss://livekit.dcl.org?access_token=')
    })

    it('refuses to initialize when misconfigured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit'
      })
      const logs = await createLogComponent({ config })

      await expect(createCommsAdapterComponent({ config, logs })).rejects.toThrow(
        'Configuration: string LIVEKIT_HOST is required'
      )
    })
  })

  describe('invalid adapter', function () {
    it('refuses to initialize when misconfigured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'other'
      })
      const logs = await createLogComponent({ config })

      await expect(createCommsAdapterComponent({ config, logs })).rejects.toThrow('Invalid comms adapter: other')
    })
  })
})
