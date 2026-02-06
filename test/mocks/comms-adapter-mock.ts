import { EthAddress } from '@dcl/schemas'
import { CommsStatus, ICommsAdapter } from '../../src/types'

export function createMockCommsAdapterComponent(): ICommsAdapter {
  return {
    getWorldRoomConnectionString(_userId: EthAddress, worldName: string): Promise<string> {
      return Promise.resolve(`ws-room:ws-room-service.decentraland.org/rooms/world-${worldName}`)
    },
    getSceneRoomConnectionString(_userId: EthAddress, worldName: string, sceneId: string): Promise<string> {
      return Promise.resolve(`ws-room:ws-room-service.decentraland.org/rooms/scene-${worldName}-${sceneId}`)
    },
    getWorldRoomParticipantCount(_worldName: string): Promise<number> {
      return Promise.resolve(0)
    },
    getWorldSceneRoomsParticipantCount(_worldName: string): Promise<number> {
      return Promise.resolve(0)
    },
    status(): Promise<CommsStatus> {
      return Promise.resolve({
        adapterType: 'mock',
        statusUrl: 'http://localhost:3000',
        commitHash: 'unknown',
        users: 2,
        rooms: 1,
        details: [
          {
            worldName: 'world-name.dcl.eth',
            users: 2
          }
        ],
        timestamp: Date.now()
      })
    }
  }
}
