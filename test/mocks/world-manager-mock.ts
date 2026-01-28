import { IWorldsManager } from '../../src/types'

export function createMockedWorldsManager(
  overrides?: Partial<jest.Mocked<IWorldsManager>>
): jest.Mocked<IWorldsManager> {
  return {
    getWorldSettings: jest.fn(),
    updateWorldSettings: jest.fn(),
    getRawWorldRecords: jest.fn(),
    getDeployedWorldCount: jest.fn(),
    getMetadataForWorld: jest.fn(),
    getEntityForWorlds: jest.fn(),
    deployScene: jest.fn(),
    undeployScene: jest.fn(),
    storePermissions: jest.fn(),
    permissionCheckerForWorld: jest.fn(),
    undeployWorld: jest.fn(),
    getContributableDomains: jest.fn(),
    getWorldScenes: jest.fn(),
    getTotalWorldSize: jest.fn(),
    getWorldBoundingRectangle: jest.fn(),
    getWorlds: jest.fn(),
    ...overrides
  }
}
