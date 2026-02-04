import { test } from '../components'
import { defaultAccess } from '../../src/logic/access'

test('world manifest handler /world/:world_name/manifest', function ({ components, stubComponents }) {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the world does not exist', () => {
    let worldName: string

    beforeEach(() => {
      const { worldCreator } = components
      worldName = worldCreator.randomWorldName()
    })

    it('should respond with 404 status and an error message', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch(`/world/${worldName}/manifest`)

      expect(response.status).toEqual(404)
      expect(await response.json()).toMatchObject({
        message: `World "${worldName}" has no scenes deployed.`
      })
    })
  })

  describe('when the world exists but has no scenes', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator, worldsManager } = components

      worldName = worldCreator.randomWorldName()
      await worldsManager.storeAccess(worldName, defaultAccess())
    })

    it('should respond with 404 status and an error message', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch(`/world/${worldName}/manifest`)

      expect(response.status).toEqual(404)
      expect(await response.json()).toMatchObject({
        message: `World "${worldName}" has no scenes deployed.`
      })
    })
  })

  describe('when the world exists with a single scene', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components

      worldName = worldCreator.randomWorldName()
      await worldCreator.createWorldWithScene({
        worldName: worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })
    })

    it('should respond with 200 and the world manifest', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch(`/world/${worldName}/manifest`)

      expect(response.status).toEqual(200)
      expect(await response.json()).toEqual({
        occupied: ['20,24'],
        spawn_coordinate: { x: '20', y: '24' },
        total: 1
      })
    })
  })

  describe('when the world has a scene with multiple parcels', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components

      worldName = worldCreator.randomWorldName()
      await worldCreator.createWorldWithScene({
        worldName: worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '10,10',
            parcels: ['10,10', '10,11', '11,10', '11,11']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })
    })

    it('should respond with all occupied parcels sorted', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch(`/world/${worldName}/manifest`)

      expect(response.status).toEqual(200)
      expect(await response.json()).toEqual({
        occupied: ['10,10', '10,11', '11,10', '11,11'],
        spawn_coordinate: { x: '10', y: '10' },
        total: 4
      })
    })
  })

  describe('when the world has multiple scenes', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components

      worldName = worldCreator.randomWorldName()

      // First scene
      await worldCreator.createWorldWithScene({
        worldName: worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24', '20,25']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      // Second scene at different parcels
      await worldCreator.createWorldWithScene({
        worldName: worldName,
        metadata: {
          main: 'def.txt',
          scene: {
            base: '30,34',
            parcels: ['30,34', '30,35']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })
    })

    it('should respond with all occupied parcels from all scenes', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch(`/world/${worldName}/manifest`)

      expect(response.status).toEqual(200)
      expect(await response.json()).toEqual({
        occupied: ['20,24', '20,25', '30,34', '30,35'],
        spawn_coordinate: { x: '20', y: '24' },
        total: 4
      })
    })
  })

  describe('when the world has custom spawn coordinates', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator, worldsManager } = components

      worldName = worldCreator.randomWorldName()
      const created = await worldCreator.createWorldWithScene({
        worldName: worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '10,10',
            parcels: ['10,10', '10,11', '11,10', '11,11']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      // Set custom spawn coordinates
      const owner = created.owner.authChain[0].payload
      await worldsManager.updateWorldSettings(worldName, owner, { spawnCoordinates: '11,11' })
    })

    it('should respond with the custom spawn coordinates', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch(`/world/${worldName}/manifest`)

      expect(response.status).toEqual(200)
      expect(await response.json()).toEqual({
        occupied: ['10,10', '10,11', '11,10', '11,11'],
        spawn_coordinate: { x: '11', y: '11' },
        total: 4
      })
    })
  })

  describe('when the world has negative coordinates', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components

      worldName = worldCreator.randomWorldName()
      await worldCreator.createWorldWithScene({
        worldName: worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '-5,-3',
            parcels: ['-5,-3', '-5,-2', '-4,-3']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })
    })

    it('should handle negative coordinates correctly', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch(`/world/${worldName}/manifest`)

      expect(response.status).toEqual(200)
      expect(await response.json()).toEqual({
        occupied: ['-5,-3', '-5,-2', '-4,-3'],
        spawn_coordinate: { x: '-5', y: '-3' },
        total: 3
      })
    })
  })

  describe('when the world name is deny-listed', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components
      const { nameDenyListChecker } = stubComponents

      const result = await worldCreator.createWorldWithScene()
      worldName = result.worldName

      nameDenyListChecker.checkNameDenyList.withArgs(worldName).resolves(false)
    })

    it('should respond with 404 status and an error message', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch(`/world/${worldName}/manifest`)

      expect(response.status).toEqual(404)
      expect(await response.json()).toMatchObject({
        message: `World "${worldName}" not found.`
      })
    })
  })
})
