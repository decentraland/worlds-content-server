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
  })
})
