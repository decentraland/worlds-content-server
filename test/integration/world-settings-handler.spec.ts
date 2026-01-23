import { test } from '../components'
import { getIdentity, Identity } from '../utils'
import { IAuthenticatedFetchComponent } from '../../src/types'
import { IPermissionsComponent } from '../../src/logic/permissions'
import { defaultAccess } from '../../src/logic/access'

const SETTINGS_METADATA = {
  origin: 'https://builder.decentraland.org',
  intent: 'dcl:builder:update-world-settings',
  signer: 'dcl:builder',
  isGuest: 'false'
}

const makeSignedRequest = (
  localFetch: IAuthenticatedFetchComponent,
  path: string,
  identity: Identity,
  body: Record<string, any>,
  method: string = 'PUT'
) => {
  return localFetch.fetch(path, {
    method,
    identity,
    metadata: SETTINGS_METADATA,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

test('WorldSettingsHandler', ({ components, stubComponents }) => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('GET /world/:world_name/settings', () => {
    describe('when the world has settings configured', () => {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName

        await worldsManager.updateWorldSettings(worldName, { spawnCoordinates: '20,24' })
      })

      it('should return the world settings', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/settings`)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          spawnCoordinates: '20,24'
        })
      })
    })

    describe('when the world exists with a scene', () => {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName
      })

      it('should return the world settings with spawn coordinates from scene base', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/settings`)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          spawnCoordinates: '20,24'
        })
      })
    })

    describe('when the world does not exist', () => {
      let worldName: string

      beforeEach(() => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
      })

      it('should respond with 404', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/settings`)

        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({
          error: `World "${worldName}" not found or has no settings configured.`
        })
      })
    })

    describe('when the world exists but has no scenes', () => {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        worldName = worldCreator.randomWorldName()

        // Create a world entry without deploying a scene
        await worldsManager.storeAccess(worldName, defaultAccess())
      })

      it('should return settings with undefined spawn coordinates', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/settings`)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({})
      })
    })
  })

  describe('PUT /world/:world_name/settings', () => {
    describe('when the user owns the world name', () => {
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

      it('should update the world settings successfully', async () => {
        const { localFetch, worldsManager } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '20,24'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'World settings updated successfully',
          settings: {
            spawnCoordinates: '20,24'
          }
        })

        const settings = await worldsManager.getWorldSettings(worldName)
        expect(settings).toMatchObject({
          spawnCoordinates: '20,24'
        })
      })
    })

    describe('when the user has deployment permission but does not own the name', () => {
      let deployer: Identity
      let worldName: string
      let permissions: IPermissionsComponent

      beforeEach(async () => {
        const { worldCreator } = components
        permissions = components.permissions

        deployer = await getIdentity()

        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName

        // Grant deployment permission to the deployer
        await permissions.grantWorldWidePermission(worldName, 'deployment', [
          deployer.realAccount.address.toLowerCase()
        ])
      })

      it('should respond with 403 unauthorized', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, deployer, {
          spawn_coordinates: '20,24'
        })

        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({
          error: 'Unauthorized. You do not have permission to update settings for this world.'
        })
      })
    })

    describe('when the user does not have permission', () => {
      let identity: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        identity = await getIdentity()
        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName
      })

      it('should respond with 403 unauthorized', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '20,24'
        })

        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({
          error: 'Unauthorized. You do not have permission to update settings for this world.'
        })
      })
    })

    describe('when the spawn coordinates are outside the world shape rectangle', () => {
      let identity: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        identity = await getIdentity()
        // Default scene has parcel '20,24', so bounding rectangle is (20,24) to (20,24)
        const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
        worldName = created.worldName

        stubComponents.namePermissionChecker.checkPermission
          .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
          .resolves(true)
      })

      it('should respond with 400 validation error', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '99,99'
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: 'Invalid spawnCoordinates "99,99". It must be within the world shape rectangle: (20,24) to (20,24).'
        })
      })
    })

    describe('when the spawn coordinates are on an actual scene parcel', () => {
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
              base: '20,24',
              parcels: ['20,24', '21,24', '22,24']
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

      it('should successfully update spawn coordinates to a scene parcel', async () => {
        const { localFetch, worldsManager } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '21,24'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'World settings updated successfully',
          settings: {
            spawnCoordinates: '21,24'
          }
        })

        const settings = await worldsManager.getWorldSettings(worldName)
        expect(settings).toMatchObject({
          spawnCoordinates: '21,24'
        })
      })
    })

    describe('when the spawn coordinates are within the world shape rectangle but not on a scene parcel', () => {
      let identity: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        identity = await getIdentity()
        // Create a world with multiple parcels to have a larger bounding rectangle
        const created = await worldCreator.createWorldWithScene({
          owner: identity.authChain,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24', '22,26'] // Bounding rectangle is (20,24) to (22,26)
            },
            worldConfiguration: {
              name: undefined // Will be auto-generated
            }
          }
        })
        worldName = created.worldName

        stubComponents.namePermissionChecker.checkPermission
          .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
          .resolves(true)
      })

      it('should successfully update spawn coordinates within the rectangle', async () => {
        const { localFetch, worldsManager } = components

        // Coordinate (21,25) is within the rectangle but not on an actual parcel
        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '21,25'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'World settings updated successfully',
          settings: {
            spawnCoordinates: '21,25'
          }
        })

        const settings = await worldsManager.getWorldSettings(worldName)
        expect(settings).toMatchObject({
          spawnCoordinates: '21,25'
        })
      })
    })

    describe('when the request is not signed', () => {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName
      })

      it('should respond with 400 and require signed fetch', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spawn_coordinates: '20,24' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: 'Invalid Auth Chain',
          message: 'This endpoint requires a signed fetch request. See ADR-44.'
        })
      })
    })

    describe('when the request body is invalid', () => {
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

      describe('and spawn_coordinates is missing', () => {
        it('should respond with 400', async () => {
          const { localFetch } = components

          const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {})

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            message: 'Invalid JSON body'
          })
        })
      })

      describe('and spawn_coordinates has invalid format', () => {
        it('should respond with 400', async () => {
          const { localFetch } = components

          const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
            spawn_coordinates: 'invalid'
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            message: 'Invalid JSON body'
          })
        })
      })

      describe('and spawn_coordinates has negative values outside the world shape', () => {
        it('should respond with 400 validation error since coordinates are outside the world shape rectangle', async () => {
          const { localFetch } = components

          const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
            spawn_coordinates: '-5,-10'
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Invalid spawnCoordinates "-5,-10". It must be within the world shape rectangle: (20,24) to (20,24).'
          })
        })
      })

      describe('and spawn_coordinates is an empty string', () => {
        it('should respond with 400', async () => {
          const { localFetch } = components

          const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
            spawn_coordinates: ''
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            message: 'Invalid JSON body'
          })
        })
      })
    })

    describe('when the world exists but has no scenes', () => {
      let identity: Identity
      let worldName: string

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        identity = await getIdentity()
        worldName = worldCreator.randomWorldName()

        // Create a world entry without deploying a scene
        await worldsManager.storeAccess(worldName, defaultAccess())

        stubComponents.namePermissionChecker.checkPermission
          .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
          .resolves(true)
      })

      it('should respond with 400 validation error since there are no scenes deployed', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '10,20'
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: 'Invalid spawnCoordinates "10,20". The world has no deployed scenes.'
        })
      })
    })
  })
})
