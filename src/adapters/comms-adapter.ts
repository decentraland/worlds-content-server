import { AppComponents, ICommsAdapter } from '../types'
import { AccessToken } from 'livekit-server-sdk'
import { EthAddress } from '@dcl/schemas'

export async function createCommsAdapterComponent({
  config,
  logs
}: Pick<AppComponents, 'config' | 'logs'>): Promise<ICommsAdapter> {
  const logger = logs.getLogger('comms-adapter')

  const adapterType = await config.requireString('COMMS_ADAPTER')
  switch (adapterType) {
    case 'ws-room':
      const fixedAdapter = await config.requireString('COMMS_FIXED_ADAPTER')
      logger.info(`Using ws-room-service adapter with template baseUrl: ${fixedAdapter}`)
      return createWsRoomAdapter(fixedAdapter)

    case 'livekit':
      const host = await config.requireString('LIVEKIT_HOST')
      logger.info(`Using livekit adapter with host: ${host}`)
      const apiKey = await config.requireString('LIVEKIT_API_KEY')
      const apiSecret = await config.requireString('LIVEKIT_API_SECRET')
      return createLiveKitAdapter(host, apiKey, apiSecret)

    default:
      throw Error(`Invalid comms adapter: ${adapterType}`)
  }
}

function createWsRoomAdapter(fixedAdapter: string): ICommsAdapter {
  const fixedAdapterPrefix = fixedAdapter.substring(0, fixedAdapter.lastIndexOf('/'))
  return {
    connectionString: async function (userId: EthAddress, roomId: string): Promise<string> {
      return `${fixedAdapterPrefix}/${roomId}`
    }
  }
}

function createLiveKitAdapter(host: string, apiKey: string, apiSecret: string): ICommsAdapter {
  return {
    connectionString: async function (userId: string, roomId: string): Promise<string> {
      const token = new AccessToken(apiKey, apiSecret, {
        identity: userId,
        ttl: 5 * 60 // 5 minutes
      })
      token.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true })
      return `livekit:${host}?access_token=${token.toJwt()}`
    }
  }
}
