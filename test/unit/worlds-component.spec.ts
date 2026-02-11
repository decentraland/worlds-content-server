import { createWorldsComponent } from '../../src/logic/worlds/component'
import { IWorldsComponent } from '../../src/logic/worlds/types'
import { IWorldsManager, TWO_DAYS_IN_MS } from '../../src/types'
import { EntityType, Events } from '@dcl/schemas'
import { IPublisherComponent } from '@dcl/sns-component'

describe('WorldsComponent', () => {
  let worldsComponent: IWorldsComponent
  let worldsManager: jest.Mocked<IWorldsManager>
  let snsClient: jest.Mocked<IPublisherComponent>

  beforeEach(() => {
    worldsManager = {
      getRawWorldRecords: jest.fn(),
      getWorldScenes: jest.fn(),
      undeployWorld: jest.fn(),
      undeployScene: jest.fn()
    } as unknown as jest.Mocked<IWorldsManager>

    snsClient = {
      publishMessage: jest.fn(),
      publishMessages: jest.fn()
    } as jest.Mocked<IPublisherComponent>

    worldsComponent = createWorldsComponent({ worldsManager, snsClient })
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
                timestamp: Date.now(),
                content: []
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

  describe('when undeploying an entire world', () => {
    beforeEach(() => {
      worldsManager.undeployWorld.mockResolvedValue(undefined)
      snsClient.publishMessages.mockResolvedValue({
        Successful: [{ Id: 'id', MessageId: 'msg-id', SequenceNumber: '1' }],
        Failed: [],
        $metadata: {}
      } as any)
    })

    it('should undeploy the world with the given name', async () => {
      await worldsComponent.undeployWorld('my-world')

      expect(worldsManager.undeployWorld).toHaveBeenCalledWith('my-world')
    })

    it('should publish a WorldUndeploymentEvent with the world name', async () => {
      await worldsComponent.undeployWorld('my-world')

      expect(snsClient.publishMessages).toHaveBeenCalledWith([
        expect.objectContaining({
          type: Events.Type.WORLD,
          subType: Events.SubType.Worlds.WORLD_UNDEPLOYMENT,
          key: 'my-world',
          timestamp: expect.any(Number),
          metadata: {
            worldName: 'my-world'
          }
        })
      ])
    })
  })

  describe('when undeploying specific scenes from a world', () => {
    describe('and there are matching scenes', () => {
      beforeEach(() => {
        worldsManager.getWorldScenes.mockResolvedValueOnce({
          scenes: [
            {
              worldName: 'test-world',
              entityId: 'entity-1',
              deployer: '0x1234',
              deploymentAuthChain: [],
              entity: {
                id: 'entity-1',
                version: 'v3',
                type: EntityType.SCENE,
                pointers: ['0,0', '1,0'],
                timestamp: Date.now(),
                content: []
              },
              parcels: ['0,0', '1,0'],
              size: BigInt(1000),
              createdAt: new Date()
            },
            {
              worldName: 'test-world',
              entityId: 'entity-2',
              deployer: '0x1234',
              deploymentAuthChain: [],
              entity: {
                id: 'entity-2',
                version: 'v3',
                type: EntityType.SCENE,
                pointers: ['5,5'],
                timestamp: Date.now(),
                content: []
              },
              parcels: ['5,5'],
              size: BigInt(500),
              createdAt: new Date()
            }
          ],
          total: 2
        })
        worldsManager.undeployScene.mockResolvedValue(undefined)
        snsClient.publishMessages.mockResolvedValue({
          Successful: [{ Id: 'id', MessageId: 'msg-id', SequenceNumber: '1' }],
          Failed: [],
          $metadata: {}
        } as any)
      })

      it('should query the affected scenes by world name and coordinates', async () => {
        await worldsComponent.undeployWorldScenes('test-world', ['0,0', '5,5'])

        expect(worldsManager.getWorldScenes).toHaveBeenCalledWith({
          worldName: 'test-world',
          coordinates: ['0,0', '5,5']
        })
      })

      it('should undeploy the scenes for the given parcels', async () => {
        await worldsComponent.undeployWorldScenes('test-world', ['0,0', '5,5'])

        expect(worldsManager.undeployScene).toHaveBeenCalledWith('test-world', ['0,0', '5,5'])
      })

      it('should publish a WorldScenesUndeploymentEvent with entity IDs and base parcels', async () => {
        await worldsComponent.undeployWorldScenes('test-world', ['0,0', '5,5'])

        expect(snsClient.publishMessages).toHaveBeenCalledWith([
          expect.objectContaining({
            type: Events.Type.WORLD,
            subType: Events.SubType.Worlds.WORLD_SCENES_UNDEPLOYMENT,
            key: 'test-world',
            timestamp: expect.any(Number),
            metadata: {
              worldName: 'test-world',
              scenes: [
                { entityId: 'entity-1', baseParcel: '0,0' },
                { entityId: 'entity-2', baseParcel: '5,5' }
              ]
            }
          })
        ])
      })
    })

    describe('and there are no matching scenes', () => {
      beforeEach(() => {
        worldsManager.getWorldScenes.mockResolvedValueOnce({
          scenes: [],
          total: 0
        })
        worldsManager.undeployScene.mockResolvedValue(undefined)
      })

      it('should still undeploy the given parcels', async () => {
        await worldsComponent.undeployWorldScenes('test-world', ['99,99'])

        expect(worldsManager.undeployScene).toHaveBeenCalledWith('test-world', ['99,99'])
      })

      it('should not publish any event', async () => {
        await worldsComponent.undeployWorldScenes('test-world', ['99,99'])

        expect(snsClient.publishMessages).not.toHaveBeenCalled()
      })
    })
  })
})
