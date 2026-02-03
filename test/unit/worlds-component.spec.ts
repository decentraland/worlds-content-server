import { createWorldsComponent } from '../../src/logic/worlds/component'
import { IWorldsComponent } from '../../src/logic/worlds/types'
import { IWorldsManager, TWO_DAYS_IN_MS } from '../../src/types'
import { EntityType } from '@dcl/schemas'

describe('WorldsComponent', () => {
  let worldsComponent: IWorldsComponent
  let worldsManager: jest.Mocked<IWorldsManager>

  beforeEach(() => {
    worldsManager = {
      getRawWorldRecords: jest.fn(),
      getWorldScenes: jest.fn()
    } as unknown as jest.Mocked<IWorldsManager>

    worldsComponent = createWorldsComponent({ worldsManager })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when checking if a world is blocked', () => {
    describe('and blockedSince is undefined', () => {
      it('should return false', () => {
        const result = worldsComponent.isWorldBlocked(undefined)
        expect(result).toBe(false)
      })
    })

    describe('and the world was blocked less than two days ago', () => {
      let blockedSince: Date

      beforeEach(() => {
        blockedSince = new Date()
        blockedSince.setTime(blockedSince.getTime() - TWO_DAYS_IN_MS + 1000) // Just under 2 days
      })

      it('should return false (within grace period)', () => {
        const result = worldsComponent.isWorldBlocked(blockedSince)
        expect(result).toBe(false)
      })
    })

    describe('and the world was blocked exactly two days ago', () => {
      let blockedSince: Date

      beforeEach(() => {
        blockedSince = new Date()
        // Subtract TWO_DAYS_IN_MS minus a small buffer to ensure we're at/within the boundary
        // even with test execution delays
        blockedSince.setTime(blockedSince.getTime() - TWO_DAYS_IN_MS + 100)
      })

      it('should return false (at grace period boundary)', () => {
        const result = worldsComponent.isWorldBlocked(blockedSince)
        expect(result).toBe(false)
      })
    })

    describe('and the world was blocked more than two days ago', () => {
      let blockedSince: Date

      beforeEach(() => {
        blockedSince = new Date()
        blockedSince.setTime(blockedSince.getTime() - TWO_DAYS_IN_MS - 1000) // Just over 2 days
      })

      it('should return true (beyond grace period)', () => {
        const result = worldsComponent.isWorldBlocked(blockedSince)
        expect(result).toBe(true)
      })
    })
  })

  describe('when checking if a world is valid', () => {
    describe('and the world does not exist', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce({
          records: [],
          total: 0
        })
      })

      it('should return false', async () => {
        const result = await worldsComponent.isWorldValid('non-existent-world')
        expect(result).toBe(false)
      })

      it('should query with the correct world name', async () => {
        await worldsComponent.isWorldValid('test-world')
        expect(worldsManager.getRawWorldRecords).toHaveBeenCalledWith({ worldName: 'test-world' })
      })
    })

    describe('and the world exists', () => {
      describe('and it is not blocked', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce({
            records: [
              {
                name: 'test-world',
                owner: '0x1234',
                blocked_since: null
              }
            ],
            total: 1
          } as any)
        })

        it('should return true', async () => {
          const result = await worldsComponent.isWorldValid('test-world')
          expect(result).toBe(true)
        })
      })

      describe('and it is blocked but within the grace period', () => {
        let blockedSince: Date

        beforeEach(() => {
          blockedSince = new Date()
          blockedSince.setTime(blockedSince.getTime() - TWO_DAYS_IN_MS + 60000) // 1 minute under 2 days

          worldsManager.getRawWorldRecords.mockResolvedValueOnce({
            records: [
              {
                name: 'test-world',
                owner: '0x1234',
                blocked_since: blockedSince
              }
            ],
            total: 1
          } as any)
        })

        it('should return true', async () => {
          const result = await worldsComponent.isWorldValid('test-world')
          expect(result).toBe(true)
        })
      })

      describe('and it is blocked beyond the grace period', () => {
        let blockedSince: Date

        beforeEach(() => {
          blockedSince = new Date()
          blockedSince.setTime(blockedSince.getTime() - TWO_DAYS_IN_MS - 60000) // 1 minute over 2 days

          worldsManager.getRawWorldRecords.mockResolvedValueOnce({
            records: [
              {
                name: 'test-world',
                owner: '0x1234',
                blocked_since: blockedSince
              }
            ],
            total: 1
          } as any)
        })

        it('should return false', async () => {
          const result = await worldsComponent.isWorldValid('test-world')
          expect(result).toBe(false)
        })
      })
    })
  })

  describe('when checking if a world has a scene', () => {
    describe('and the scene exists', () => {
      beforeEach(() => {
        worldsManager.getWorldScenes.mockResolvedValueOnce({
          scenes: [
            {
              worldName: 'test-world',
              entityId: 'scene-123',
              deployer: '0x1234',
              deploymentAuthChain: [],
              entity: {
                id: 'scene-123',
                version: 'v3',
                type: EntityType.SCENE,
                pointers: ['0,0'],
                timestamp: Date.now()
              },
              parcels: ['0,0'],
              size: BigInt(1000),
              createdAt: new Date()
            }
          ],
          total: 1
        })
      })

      it('should return true', async () => {
        const result = await worldsComponent.hasWorldScene('test-world', 'scene-123')
        expect(result).toBe(true)
      })

      it('should query with the correct parameters', async () => {
        await worldsComponent.hasWorldScene('test-world', 'scene-123')
        expect(worldsManager.getWorldScenes).toHaveBeenCalledWith(
          { worldName: 'test-world', entityId: 'scene-123' },
          { limit: 1 }
        )
      })
    })

    describe('and the scene does not exist', () => {
      beforeEach(() => {
        worldsManager.getWorldScenes.mockResolvedValueOnce({
          scenes: [],
          total: 0
        })
      })

      it('should return false', async () => {
        const result = await worldsComponent.hasWorldScene('test-world', 'non-existent-scene')
        expect(result).toBe(false)
      })
    })
  })
})
