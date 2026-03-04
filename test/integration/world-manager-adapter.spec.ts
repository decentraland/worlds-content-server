import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'
import { makeid } from '../utils'
import { defaultAccess } from '../../src/logic/access'

test('WorldManagerAdapter', function ({ components }) {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when getting the total size of a world', function () {
    describe('when a world has a single deployed scene', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const created = await worldCreator.createWorldWithScene({ files })
        worldName = created.worldName
      })

      it('should return the total size of all scenes', async () => {
        const { worldsManager } = components

        const totalSize = await worldsManager.getTotalWorldSize(worldName)

        expect(totalSize).toBeGreaterThan(BigInt(0))
      })
    })

    describe('when a world has multiple scenes deployed', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()

        const files1 = new Map<string, Uint8Array>()
        files1.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: { base: '0,0', parcels: ['0,0'] },
            worldConfiguration: { name: worldName }
          },
          files: files1
        })

        const files2 = new Map<string, Uint8Array>()
        files2.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: { base: '1,1', parcels: ['1,1'] },
            worldConfiguration: { name: worldName }
          },
          files: files2
        })
      })

      it('should return the sum of all scene sizes', async () => {
        const { worldsManager } = components

        const { scenes } = await worldsManager.getWorldScenes({ worldName })
        const expectedTotalSize = scenes.reduce((acc, scene) => acc + scene.size, BigInt(0))

        const totalSize = await worldsManager.getTotalWorldSize(worldName)

        expect(totalSize).toBe(expectedTotalSize)
      })
    })

    describe('when a world does not exist', function () {
      let worldName: string

      beforeEach(() => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
      })

      it('should return zero', async () => {
        const { worldsManager } = components

        const totalSize = await worldsManager.getTotalWorldSize(worldName)

        expect(totalSize).toBe(BigInt(0))
      })
    })

    describe('when a world exists but has no scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        worldName = worldCreator.randomWorldName()

        // Create a world entry without deploying a scene
        await worldsManager.storeAccess(worldName, defaultAccess())
      })

      it('should return zero', async () => {
        const { worldsManager } = components

        const totalSize = await worldsManager.getTotalWorldSize(worldName)

        expect(totalSize).toBe(BigInt(0))
      })
    })

    describe('when a world has only undeployed scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const created = await worldCreator.createWorldWithScene({ files })
        worldName = created.worldName

        await worldsManager.undeployWorld(worldName)
      })

      it('should return zero', async () => {
        const { worldsManager } = components

        const totalSize = await worldsManager.getTotalWorldSize(worldName)

        expect(totalSize).toBe(BigInt(0))
      })
    })
  })

  describe('when soft-deleting scenes', function () {
    describe('when undeploying a world', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const created = await worldCreator.createWorldWithScene({ files })
        worldName = created.worldName
      })

      it('should mark scenes as UNDEPLOYED instead of deleting them', async () => {
        const { worldsManager } = components

        // Verify scene exists with DEPLOYED status
        const beforeUndeploy = await worldsManager.getWorldScenes({ worldName })
        expect(beforeUndeploy.total).toBe(1)

        await worldsManager.undeployWorld(worldName)

        // Normal query should not return undeployed scenes
        const afterUndeploy = await worldsManager.getWorldScenes({ worldName })
        expect(afterUndeploy.total).toBe(0)

        // Query with includeUndeployed should still find it
        const withUndeployed = await worldsManager.getWorldScenes({ worldName, includeUndeployed: true })
        expect(withUndeployed.total).toBe(1)
        expect(withUndeployed.scenes[0].status).toBe('UNDEPLOYED')
      })
    })

    describe('when undeploying a scene', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: { base: '0,0', parcels: ['0,0'] },
            worldConfiguration: { name: worldName }
          },
          files
        })
      })

      it('should soft-delete the scene and still be findable with includeUndeployed', async () => {
        const { worldsManager } = components

        await worldsManager.undeployScene(worldName, ['0,0'])

        const deployed = await worldsManager.getWorldScenes({ worldName })
        expect(deployed.total).toBe(0)

        const all = await worldsManager.getWorldScenes({ worldName, includeUndeployed: true })
        expect(all.total).toBe(1)
        expect(all.scenes[0].status).toBe('UNDEPLOYED')
      })
    })

    describe('when deploying over existing scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: { base: '0,0', parcels: ['0,0'] },
            worldConfiguration: { name: worldName }
          },
          files
        })

        // Deploy a new scene on the same parcel
        await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: { base: '0,0', parcels: ['0,0'] },
            worldConfiguration: { name: worldName }
          },
          files
        })
      })

      it('should soft-delete the old scene and have the new one deployed', async () => {
        const { worldsManager } = components

        const deployed = await worldsManager.getWorldScenes({ worldName })
        expect(deployed.total).toBe(1)
        expect(deployed.scenes[0].status).toBe('DEPLOYED')

        const all = await worldsManager.getWorldScenes({ worldName, includeUndeployed: true })
        expect(all.total).toBe(2)
      })
    })
  })

  describe('when evicting undeployed scenes', function () {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components

      const files = new Map<string, Uint8Array>()
      files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

      const created = await worldCreator.createWorldWithScene({ files })
      worldName = created.worldName
    })

    describe('when the scene was undeployed past the TTL', function () {
      const ONE_HOUR_MS = 60 * 60 * 1000

      beforeEach(async () => {
        const { worldsManager, database } = components

        await worldsManager.undeployWorld(worldName)

        // Backdate the updated_at to 1 day ago so it exceeds the 1-hour TTL
        await database.query(`
          UPDATE world_scenes SET updated_at = NOW() - INTERVAL '1 day'
          WHERE world_name = '${worldName.toLowerCase()}' AND status = 'UNDEPLOYED'
        `)
      })

      it('should permanently delete the undeployed scenes', async () => {
        const { worldsManager } = components

        const evicted = await worldsManager.evictUndeployedScenes(ONE_HOUR_MS)
        expect(evicted).toBeGreaterThan(0)

        // Should not be findable even with includeUndeployed
        const all = await worldsManager.getWorldScenes({ worldName, includeUndeployed: true })
        expect(all.total).toBe(0)
      })
    })

    describe('when the scene was undeployed within the TTL', function () {
      const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

      beforeEach(async () => {
        const { worldsManager } = components

        await worldsManager.undeployWorld(worldName)
      })

      it('should not delete the undeployed scenes', async () => {
        const { worldsManager } = components

        const evicted = await worldsManager.evictUndeployedScenes(ONE_YEAR_MS)
        expect(evicted).toBe(0)

        // Should still be findable with includeUndeployed
        const all = await worldsManager.getWorldScenes({ worldName, includeUndeployed: true })
        expect(all.total).toBe(1)
      })
    })
  })

  describe('when getting the deployed world count', function () {
    describe('when a world has deployed scenes', function () {
      beforeEach(async () => {
        const { worldCreator } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        await worldCreator.createWorldWithScene({ files })
      })

      it('should include the world in the count', async () => {
        const { worldsManager } = components

        const count = await worldsManager.getDeployedWorldCount()

        expect(count.dcl).toBeGreaterThan(0)
      })
    })

    describe('when a world has only undeployed scenes', function () {
      let countBeforeUndeploy: { ens: number; dcl: number }

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const created = await worldCreator.createWorldWithScene({ files })

        countBeforeUndeploy = await worldsManager.getDeployedWorldCount()

        await worldsManager.undeployWorld(created.worldName)
      })

      it('should not include the world in the count', async () => {
        const { worldsManager } = components

        const countAfterUndeploy = await worldsManager.getDeployedWorldCount()

        expect(countAfterUndeploy.dcl).toBe(countBeforeUndeploy.dcl - 1)
      })
    })
  })

  describe('when getting the world bounding rectangle', function () {
    describe('when a world has deployed scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: { base: '0,0', parcels: ['0,0', '1,0'] },
            worldConfiguration: { name: worldName }
          },
          files
        })
      })

      it('should return the bounding rectangle', async () => {
        const { worldsManager } = components

        const rect = await worldsManager.getWorldBoundingRectangle(worldName)

        expect(rect).toBeDefined()
        expect(rect!.min.x).toBe(0)
        expect(rect!.max.x).toBe(1)
      })
    })

    describe('when a world has only undeployed scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const created = await worldCreator.createWorldWithScene({ files })
        worldName = created.worldName

        await worldsManager.undeployWorld(worldName)
      })

      it('should return undefined', async () => {
        const { worldsManager } = components

        const rect = await worldsManager.getWorldBoundingRectangle(worldName)

        expect(rect).toBeUndefined()
      })
    })
  })

  describe('when getting occupied parcels', function () {
    describe('when a world has deployed scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: { base: '0,0', parcels: ['0,0', '1,0'] },
            worldConfiguration: { name: worldName }
          },
          files
        })
      })

      it('should return the occupied parcels', async () => {
        const { worldsManager } = components

        const result = await worldsManager.getOccupiedParcels(worldName)

        expect(result.total).toBe(2)
        expect(result.parcels).toContain('0,0')
        expect(result.parcels).toContain('1,0')
      })
    })

    describe('when a world has only undeployed scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        worldName = worldCreator.randomWorldName()

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: { base: '0,0', parcels: ['0,0', '1,0'] },
            worldConfiguration: { name: worldName }
          },
          files
        })

        await worldsManager.undeployWorld(worldName)
      })

      it('should return no occupied parcels', async () => {
        const { worldsManager } = components

        const result = await worldsManager.getOccupiedParcels(worldName)

        expect(result.total).toBe(0)
        expect(result.parcels).toEqual([])
      })
    })
  })

  describe('when getting entities for worlds', function () {
    describe('when a world has deployed scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const created = await worldCreator.createWorldWithScene({ files })
        worldName = created.worldName
      })

      it('should return the entity', async () => {
        const { worldsManager } = components

        const entities = await worldsManager.getEntityForWorlds([worldName])

        expect(entities).toHaveLength(1)
      })
    })

    describe('when a world has only undeployed scenes', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const created = await worldCreator.createWorldWithScene({ files })
        worldName = created.worldName

        await worldsManager.undeployWorld(worldName)
      })

      it('should not return any entities', async () => {
        const { worldsManager } = components

        const entities = await worldsManager.getEntityForWorlds([worldName])

        expect(entities).toHaveLength(0)
      })
    })

    describe('when there are multiple worlds with mixed status', function () {
      let deployedWorldName: string
      let undeployedWorldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const deployed = await worldCreator.createWorldWithScene({ files })
        deployedWorldName = deployed.worldName

        const undeployed = await worldCreator.createWorldWithScene({ files })
        undeployedWorldName = undeployed.worldName

        await worldsManager.undeployWorld(undeployedWorldName)
      })

      it('should only return entities for the deployed world', async () => {
        const { worldsManager } = components

        const entities = await worldsManager.getEntityForWorlds([deployedWorldName, undeployedWorldName])

        expect(entities).toHaveLength(1)
      })
    })
  })

  describe('when deploying a scene with partial parcel overlap', function () {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components

      worldName = worldCreator.randomWorldName()

      const files = new Map<string, Uint8Array>()
      files.set('abc.txt', stringToUtf8Bytes(makeid(100)))

      // Deploy scene A on parcels [0,0] and [1,0]
      await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '0,0', parcels: ['0,0', '1,0'] },
          worldConfiguration: { name: worldName }
        },
        files
      })

      // Deploy scene B on parcels [1,0] and [2,0] — overlaps on [1,0]
      await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '1,0', parcels: ['1,0', '2,0'] },
          worldConfiguration: { name: worldName }
        },
        files
      })
    })

    it('should soft-delete the overlapping scene', async () => {
      const { worldsManager } = components

      const all = await worldsManager.getWorldScenes({ worldName, includeUndeployed: true })

      expect(all.total).toBe(2)

      const deployed = all.scenes.filter((s) => s.status === 'DEPLOYED')
      const undeployed = all.scenes.filter((s) => s.status === 'UNDEPLOYED')

      expect(deployed).toHaveLength(1)
      expect(undeployed).toHaveLength(1)
    })

    it('should only have the new scene parcels as occupied', async () => {
      const { worldsManager } = components

      const result = await worldsManager.getOccupiedParcels(worldName)

      expect(result.total).toBe(2)
      expect(result.parcels).toContain('1,0')
      expect(result.parcels).toContain('2,0')
      expect(result.parcels).not.toContain('0,0')
    })
  })
})
