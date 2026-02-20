import { IWorldsComponent } from '../../src/logic/worlds/types'

export const createMockWorlds = (overrides?: Partial<jest.Mocked<IWorldsComponent>>): jest.Mocked<IWorldsComponent> => {
  return {
    isWorldValid: jest.fn(),
    isWorldBlocked: jest.fn(),
    hasWorldScene: jest.fn(),
    getWorldSceneBaseParcel: jest.fn(),
    getWorldManifest: jest.fn(),
    undeployWorld: jest.fn(),
    undeployWorldScenes: jest.fn(),
    ...overrides
  }
}
