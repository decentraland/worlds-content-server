import SQL from 'sql-template-strings'
import { test } from '../components'
import { cleanup, getIdentity } from '../utils'

test('WorldsHandler GET /worlds', function ({ components }) {
  beforeEach(async () => {
    const { storage, database } = components
    await cleanup(storage, database)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when there are no worlds', function () {
    it('should return an empty list', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch('/worlds')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({
        worlds: [],
        total: 0
      })
    })
  })

  describe('when there are deployed worlds', function () {
    let worldName1: string
    let worldName2: string
    let worldName3: string

    beforeEach(async () => {
      const { worldCreator } = components

      worldName1 = 'alpha-world.dcl.eth'
      worldName2 = 'beta-world.dcl.eth'
      worldName3 = 'gamma-world.dcl.eth'

      await worldCreator.createWorldWithScene({
        worldName: worldName1,
        metadata: {
          main: 'abc.txt',
          scene: { base: '0,0', parcels: ['0,0', '1,0'] },
          worldConfiguration: { name: worldName1 },
          display: {
            title: 'Alpha World',
            description: 'The first world'
          }
        }
      })

      await worldCreator.createWorldWithScene({
        worldName: worldName2,
        metadata: {
          main: 'abc.txt',
          scene: { base: '5,5', parcels: ['5,5', '5,6', '6,5', '6,6'] },
          worldConfiguration: { name: worldName2 },
          display: {
            title: 'Beta World',
            description: 'The second world with adventure'
          }
        }
      })

      await worldCreator.createWorldWithScene({
        worldName: worldName3,
        metadata: {
          main: 'abc.txt',
          scene: { base: '10,10', parcels: ['10,10'] },
          worldConfiguration: { name: worldName3 },
          display: {
            title: 'Gamma World',
            description: 'The third world'
          }
        }
      })
    })

    it('should return all worlds with their complete information', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch('/worlds')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.total).toBe(3)
      expect(body.worlds).toHaveLength(3)

      const alphaWorld = body.worlds.find((w: { name: string }) => w.name === worldName1)
      expect(alphaWorld).toMatchObject({
        name: worldName1,
        owner: expect.any(String),
        title: 'Alpha World',
        description: 'The first world',
        shape: { x1: 0, x2: 1, y1: 0, y2: 0 },
        spawn_coordinates: '0,0',
        single_player: false,
        show_in_places: false,
        last_deployed_at: expect.any(String),
        blocked_since: null
      })

      const betaWorld = body.worlds.find((w: { name: string }) => w.name === worldName2)
      expect(betaWorld).toMatchObject({
        name: worldName2,
        owner: expect.any(String),
        title: 'Beta World',
        description: 'The second world with adventure',
        shape: { x1: 5, x2: 6, y1: 5, y2: 6 },
        spawn_coordinates: '5,5',
        single_player: false,
        show_in_places: false,
        last_deployed_at: expect.any(String),
        blocked_since: null
      })

      const gammaWorld = body.worlds.find((w: { name: string }) => w.name === worldName3)
      expect(gammaWorld).toMatchObject({
        name: worldName3,
        owner: expect.any(String),
        title: 'Gamma World',
        description: 'The third world',
        shape: { x1: 10, x2: 10, y1: 10, y2: 10 },
        spawn_coordinates: '10,10',
        single_player: false,
        show_in_places: false,
        last_deployed_at: expect.any(String),
        blocked_since: null
      })
    })

    describe('and pagination is provided', function () {
      describe('and limit is set to 2', function () {
        it('should return only 2 worlds', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?limit=2&offset=0')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(2)
          expect(body.total).toBe(3)
        })
      })

      describe('and offset is set to 1', function () {
        it('should return results starting from the second world', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?limit=10&offset=1')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(2)
          expect(body.total).toBe(3)
        })
      })

      describe('and the offset exceeds the total number of worlds', function () {
        it('should return an empty array with the correct total', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?limit=10&offset=100')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(0)
          expect(body.total).toBe(3)
        })
      })
    })

    describe('and sorting is requested', function () {
      describe('and sort by name ascending', function () {
        it('should return worlds sorted by name in ascending order', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?sort=name&order=asc')

          expect(response.status).toBe(200)
          const body = await response.json()
          const names = body.worlds.map((w: { name: string }) => w.name)
          expect(names).toEqual([worldName1, worldName2, worldName3])
        })
      })

      describe('and sort by name descending', function () {
        it('should return worlds sorted by name in descending order', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?sort=name&order=desc')

          expect(response.status).toBe(200)
          const body = await response.json()
          const names = body.worlds.map((w: { name: string }) => w.name)
          expect(names).toEqual([worldName3, worldName2, worldName1])
        })
      })

      describe('and sort by last_deployed_at', function () {
        it('should return worlds sorted by deployment time', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?sort=last_deployed_at&order=asc')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(3)
          expect(body.total).toBe(3)
        })
      })

      describe('and an invalid sort value is provided', function () {
        it('should respond with 400', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?sort=invalid')

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Bad request',
            message: expect.stringContaining('Invalid sort parameter')
          })
        })
      })

      describe('and an invalid order value is provided', function () {
        it('should respond with 400', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?order=invalid')

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Bad request',
            message: expect.stringContaining('Invalid order parameter')
          })
        })
      })
    })

    describe('and search is requested', function () {
      describe('and the search term matches a world name', function () {
        it('should return the matching world', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?search=alpha')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(1)
          expect(body.worlds[0].name).toBe(worldName1)
        })
      })

      describe('and the search term matches a world title', function () {
        it('should return the matching world', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?search=Beta')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(1)
          expect(body.worlds[0].name).toBe(worldName2)
        })
      })

      describe('and the search term matches a world description', function () {
        it('should return the matching world', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?search=adventure')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(1)
          expect(body.worlds[0].name).toBe(worldName2)
        })
      })

      describe('and no worlds match the search', function () {
        it('should return an empty list', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?search=nonexistent')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(0)
          expect(body.total).toBe(0)
        })
      })

      describe('and the search is combined with pagination', function () {
        it('should return paginated search results', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?search=world&limit=2&offset=0')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds.length).toBeLessThanOrEqual(2)
        })
      })

      describe('and the search term is a partial match', function () {
        it('should return matching worlds using fuzzy search', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?search=alph')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(1)
          expect(body.worlds[0].name).toBe(worldName1)
        })
      })

      describe('and the search term is a substring of the title', function () {
        it('should return matching worlds using ILIKE search', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?search=Gamma')

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(1)
          expect(body.worlds[0].name).toBe(worldName3)
        })
      })
    })

    describe('and deployer filter is provided', function () {
      describe('and the deployer is not a valid Ethereum address', function () {
        it('should respond with 400', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch('/worlds?deployer=not-a-valid-address')

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Bad request',
            message: expect.stringContaining('Invalid deployer address')
          })
        })
      })

      describe('and the deployer is the owner of some worlds', function () {
        let ownerAddress: string

        beforeEach(async () => {
          const { worldsManager } = components

          const metadata = await worldsManager.getMetadataForWorld(worldName1)
          ownerAddress = metadata!.owner!
        })

        it('should return only worlds where the deployer is owner', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/worlds?deployer=${ownerAddress}`)

          expect(response.status).toBe(200)
          const body = await response.json()
          // Each world has a different owner (random identity), so only 1 world should be returned
          expect(body.worlds).toHaveLength(1)
          expect(body.total).toBe(1)
          expect(body.worlds[0].name).toBe(worldName1)
          expect(body.worlds[0].owner.toLowerCase()).toBe(ownerAddress.toLowerCase())
        })
      })

      describe('and the deployer has deployment permission', function () {
        let deployerAddress: string

        beforeEach(async () => {
          const { permissions } = components

          deployerAddress = '0x1234567890123456789012345678901234567890'

          await permissions.grantWorldWidePermission(worldName2, 'deployment', [deployerAddress])
        })

        it('should return worlds where the deployer has deployment permission', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/worlds?deployer=${deployerAddress}`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds.length).toBe(1)
          expect(body.worlds[0].name).toBe(worldName2)
        })
      })

      describe('and the deployer is neither owner nor has permission', function () {
        let unknownAddress: string

        beforeEach(() => {
          unknownAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
        })

        it('should return an empty list', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/worlds?deployer=${unknownAddress}`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.worlds).toHaveLength(0)
          expect(body.total).toBe(0)
        })
      })
    })
  })

  describe('when a world has no deployed scenes', function () {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator, worldsManager } = components

      worldName = worldCreator.randomWorldName()

      await worldCreator.createWorldWithScene({ worldName })

      await worldsManager.undeployWorld(worldName)
    })

    it('should return the world with null shape and null last_deployed_at', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch('/worlds')

      expect(response.status).toBe(200)
      const body = await response.json()
      const world = body.worlds.find((w: { name: string }) => w.name === worldName)
      expect(world).toMatchObject({
        name: worldName,
        shape: null,
        last_deployed_at: null
      })
    })
  })

  describe('when a world has multiple scenes', function () {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components

      worldName = worldCreator.randomWorldName()

      await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '0,0', parcels: ['0,0'] },
          worldConfiguration: { name: worldName }
        }
      })

      await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '5,5', parcels: ['5,5'] },
          worldConfiguration: { name: worldName }
        }
      })
    })

    it('should calculate the correct shape spanning all scenes', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch('/worlds')

      expect(response.status).toBe(200)
      const body = await response.json()
      const world = body.worlds.find((w: { name: string }) => w.name === worldName)
      expect(world.shape).toEqual({ x1: 0, x2: 5, y1: 0, y2: 5 })
    })
  })

  describe('when a world owner is blocked', function () {
    let worldName: string
    let blockedSince: Date

    beforeEach(async () => {
      const { database, worldCreator } = components

      const identity = await getIdentity()
      const result = await worldCreator.createWorldWithScene({
        owner: identity.authChain,
        metadata: {
          main: 'abc.txt',
          scene: { base: '0,0', parcels: ['0,0'] },
          worldConfiguration: { name: worldCreator.randomWorldName() },
          display: {
            title: 'Blocked World',
            description: 'A world with a blocked owner'
          }
        }
      })
      worldName = result.worldName

      blockedSince = new Date()
      blockedSince.setDate(blockedSince.getDate() - 3)
      await database.query(SQL`
        INSERT INTO blocked (wallet, created_at, updated_at)
        VALUES (${identity.realAccount.address.toLowerCase()}, ${blockedSince}, ${new Date()})
      `)
    })

    it('should return the world with blocked_since set to the blocking date', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch('/worlds')

      expect(response.status).toBe(200)
      const body = await response.json()
      const world = body.worlds.find((w: { name: string }) => w.name === worldName)
      expect(world).toMatchObject({
        name: worldName,
        title: 'Blocked World',
        description: 'A world with a blocked owner',
        blocked_since: blockedSince.toISOString()
      })
    })
  })
})
