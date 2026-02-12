import { ICacheStorageComponent } from '@dcl/core-commons'

export function createRedisMock(): jest.Mocked<ICacheStorageComponent> {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    keys: jest.fn().mockResolvedValue([]),
    setInHash: jest.fn().mockResolvedValue(undefined),
    getFromHash: jest.fn().mockResolvedValue(null),
    removeFromHash: jest.fn().mockResolvedValue(undefined),
    getAllHashFields: jest.fn().mockResolvedValue({}),
    acquireLock: jest.fn().mockResolvedValue(undefined),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    tryAcquireLock: jest.fn().mockResolvedValue(true),
    tryReleaseLock: jest.fn().mockResolvedValue(true)
  }
}
