import { test } from '../components'
import { getAuthHeaders, getIdentity, Identity } from '../utils'
import { Authenticator } from '@dcl/crypto'
import { IFetchComponent } from '@well-known-components/interfaces'
import { PermissionType } from '../../src/types'
import { defaultPermissions } from '../../src/logic/permissions-checker'

function makeSignedRequest(localFetch: IFetchComponent, path: string, identity: Identity, method: string = 'DELETE') {
  return localFetch.fetch(path, {
    method,
    headers: {
      ...getAuthHeaders(
        method,
        path,
        {
          origin: 'https://builder.decentraland.org',
          intent: 'dcl:builder:undeploy-scene',
          signer: 'dcl:builder',
          isGuest: 'false'
        },
        (payload) =>
          Authenticator.signPayload(
            {
              ephemeralIdentity: identity.ephemeralIdentity,
              expiration: new Date(),
              authChain: identity.authChain.authChain
            },
            payload
          )
      )
    }
  })
}

function buildQuery(coordinates: string[]): string {
  return coordinates.map((coordinate) => `coordinates=${coordinate}`).join('&')
}

test('ScenesHandler', function ({ components, stubComponents }) {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('GET /world/:world_name/scenes', function () {
    describe('when the world has scenes deployed', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName
      })

      it('should return the scenes', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/scenes`)

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toMatchObject({
          scenes: expect.arrayContaining([
            expect.objectContaining({
              entityId: expect.any(String)
            })
          ]),
          total: 1
        })
      })

      describe('and coordinates filter is provided', function () {
        describe("and there's a single valid coordinate", function () {
          let coordinates: string[]

          beforeEach(() => {
            coordinates = ['20,24']
          })

          it('should return scenes matching the coordinates', async () => {
            const { localFetch } = components

            const response = await localFetch.fetch(`/world/${worldName}/scenes?${buildQuery(coordinates)}`)

            expect(response.status).toBe(200)
            const body = await response.json()
            expect(body).toMatchObject({
              scenes: expect.arrayContaining([
                expect.objectContaining({
                  entityId: expect.any(String)
                })
              ]),
              total: 1
            })
          })
        })

        describe("and there's a single invalid coordinate", function () {
          let coordinates: string[]

          beforeEach(() => {
            coordinates = ['invalid']
          })

          it('should respond with 400 and the invalid coordinate', async () => {
            const { localFetch } = components

            const response = await localFetch.fetch(`/world/${worldName}/scenes?${buildQuery(coordinates)}`)

            expect(response.status).toBe(400)
            expect(await response.json()).toMatchObject({
              error: 'Bad request',
              message: 'Invalid coordinate format: invalid. Expected format: x,y (e.g., 0,0 or -1,2)'
            })
          })
        })

        describe('and there are multiple valid coordinates', function () {
          let coordinates: string[]

          beforeEach(() => {
            coordinates = ['20,24', '21,25']
          })

          it('should return scenes matching any of the coordinates', async () => {
            const { localFetch } = components

            const response = await localFetch.fetch(`/world/${worldName}/scenes?${buildQuery(coordinates)}`)

            expect(response.status).toBe(200)
            const body = await response.json()
            expect(body.total).toBeGreaterThanOrEqual(0)
          })
        })

        describe('and one of multiple coordinates is invalid', function () {
          let coordinates: string[]

          beforeEach(() => {
            coordinates = ['0,0', 'bad']
          })

          it('should respond with 400 and the first invalid coordinate', async () => {
            const { localFetch } = components

            const response = await localFetch.fetch(`/world/${worldName}/scenes?${buildQuery(coordinates)}`)

            expect(response.status).toBe(400)
            expect(await response.json()).toMatchObject({
              error: 'Bad request',
              message: 'Invalid coordinate format: bad. Expected format: x,y (e.g., 0,0 or -1,2)'
            })
          })
        })
      })

      describe('and pagination is provided', function () {
        it('should return paginated results', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/world/${worldName}/scenes?limit=10&offset=0`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body).toMatchObject({
            scenes: expect.any(Array),
            total: expect.any(Number)
          })
        })
      })
    })

    describe('when the world does not exist', function () {
      let worldName: string

      beforeEach(() => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
      })

      it('should return empty scenes array', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/scenes`)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          scenes: [],
          total: 0
        })
      })
    })

    describe('when the coordinate has negative values', function () {
      let worldName: string

      beforeEach(() => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
      })

      it('should accept negative coordinate values', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/scenes?coordinates=-10,-20`)

        expect(response.status).toBe(200)
      })
    })

    describe('when the world has multiple scenes deployed', function () {
      const sceneCoordinates = ['0,0', '1,1', '2,2']
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()

        for (const coordinate of sceneCoordinates) {
          await worldCreator.createWorldWithScene({
            worldName,
            metadata: {
              main: 'abc.txt',
              scene: { base: coordinate, parcels: [coordinate] },
              worldConfiguration: { name: worldName }
            }
          })
        }
      })

      describe('and the limit query parameter is provided with a value less than total scenes', function () {
        it('should return only the limited number of scenes', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/world/${worldName}/scenes?limit=2&offset=0`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.scenes).toHaveLength(2)
          expect(body.total).toBe(3)
          expect(body.scenes.map((s: { parcels: string[] }) => s.parcels[0])).toEqual(
            expect.arrayContaining(['0,0', '1,1'])
          )
        })
      })

      describe('and the offset query parameter is provided', function () {
        it('should return scenes starting from the offset position', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/world/${worldName}/scenes?limit=10&offset=1`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.scenes).toHaveLength(2)
          expect(body.total).toBe(3)
          expect(body.scenes.map((s: { parcels: string[] }) => s.parcels[0])).toEqual(
            expect.arrayContaining(['1,1', '2,2'])
          )
        })
      })

      describe('and the offset query parameter exceeds the total number of scenes', function () {
        it('should return an empty scenes array with the correct total', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/world/${worldName}/scenes?limit=10&offset=10`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.scenes).toHaveLength(0)
          expect(body.total).toBe(3)
        })
      })

      describe('and both limit and offset query parameters are provided', function () {
        it('should return the correct slice of scenes', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/world/${worldName}/scenes?limit=1&offset=1`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.scenes).toHaveLength(1)
          expect(body.total).toBe(3)
          expect(body.scenes[0].parcels[0]).toBe('1,1')
        })
      })

      describe('and no pagination query parameters are provided', function () {
        it('should return all scenes', async () => {
          const { localFetch } = components

          const response = await localFetch.fetch(`/world/${worldName}/scenes`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.scenes).toHaveLength(3)
          expect(body.total).toBe(3)
          expect(body.scenes.map((s: { parcels: string[] }) => s.parcels[0]).sort()).toEqual(sceneCoordinates)
        })
      })
    })
  })

  describe('DELETE /world/:world_name/scenes/:coordinate', function () {
    describe('when the user owns the world name', function () {
      let identity: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        identity = await getIdentity()
        const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
        worldName = created.worldName

        stubComponents.namePermissionChecker.checkPermission
          .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
          .resolves(true)
      })

      it('should successfully undeploy the scene and remove it from the world', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/scenes/20,24`, identity)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'Scene at parcel 20,24 undeployed successfully'
        })

        const scenesResponse = await localFetch.fetch(`/world/${worldName}/scenes`)
        const scenesBody = await scenesResponse.json()

        expect(scenesBody.scenes).toHaveLength(0)
        expect(scenesBody.total).toBe(0)
      })
    })

    describe('when the user has deployment permission', function () {
      let owner: Identity
      let deployer: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        owner = await getIdentity()
        deployer = await getIdentity()

        const created = await worldCreator.createWorldWithScene({ owner: owner.authChain })
        worldName = created.worldName

        await worldsManager.storePermissions(worldName, {
          ...defaultPermissions(),
          deployment: {
            type: PermissionType.AllowList,
            wallets: [deployer.realAccount.address.toLowerCase()]
          }
        })
      })

      it('should successfully undeploy the scene and remove it from the world', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/scenes/20,24`, deployer)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'Scene at parcel 20,24 undeployed successfully'
        })

        const scenesResponse = await localFetch.fetch(`/world/${worldName}/scenes`)
        const scenesBody = await scenesResponse.json()

        expect(scenesBody.scenes).toHaveLength(0)
        expect(scenesBody.total).toBe(0)
      })
    })

    describe('when the user does not have permission', function () {
      let identity: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        identity = await getIdentity()
        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName
      })

      it('should respond with 401 unauthorized', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/scenes/20,24`, identity)

        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({
          error: 'Not Authorized',
          message: 'Unauthorized. You do not have permission to undeploy scenes in this world.'
        })
      })
    })

    describe('when the coordinate format is invalid', function () {
      let identity: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        identity = await getIdentity()
        const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
        worldName = created.worldName

        stubComponents.namePermissionChecker.checkPermission
          .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
          .resolves(true)
      })

      it('should respond with 400', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/scenes/abc,def`, identity)

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: 'Invalid coordinate format: abc,def. Expected format: x,y (e.g., 0,0 or -1,2)'
        })
      })
    })

    describe('when the request is not signed', function () {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName
      })

      it('should respond with 400 and require signed fetch', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/scenes/0,0`, {
          method: 'DELETE'
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: 'Invalid Auth Chain',
          message: 'This endpoint requires a signed fetch request. See ADR-44.'
        })
      })
    })

    describe('when coordinate has negative values', function () {
      let identity: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        identity = await getIdentity()
        const created = await worldCreator.createWorldWithScene({
          owner: identity.authChain,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '-5,-10',
              parcels: ['-5,-10']
            },
            worldConfiguration: {
              name: undefined
            }
          }
        })
        worldName = created.worldName

        stubComponents.namePermissionChecker.checkPermission
          .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
          .resolves(true)
      })

      it('should accept negative coordinate values and remove the scene from the world', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/scenes/-5,-10`, identity)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'Scene at parcel -5,-10 undeployed successfully'
        })

        const scenesResponse = await localFetch.fetch(`/world/${worldName}/scenes`)
        const scenesBody = await scenesResponse.json()

        expect(scenesBody.scenes).toHaveLength(0)
        expect(scenesBody.total).toBe(0)
      })
    })
  })
})
