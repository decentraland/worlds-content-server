import { test } from '../components'
import { getAuthHeaders, getIdentity, Identity } from '../utils'
import { Authenticator } from '@dcl/crypto'
import { IFetchComponent } from '@well-known-components/interfaces'
import { PermissionType } from '../../src/types'
import { defaultPermissions } from '../../src/logic/permissions-checker'

const makeSignedRequest = (
  localFetch: IFetchComponent,
  path: string,
  identity: Identity,
  body: Record<string, any>,
  method: string = 'PUT'
) => {
  return localFetch.fetch(path, {
    method,
    headers: {
      ...getAuthHeaders(
        method,
        path,
        {
          origin: 'https://builder.decentraland.org',
          intent: 'dcl:builder:update-world-settings',
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
      ),
      'Content-Type': 'application/json'
    },
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

        await worldsManager.storePermissions(worldName, defaultPermissions())
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

      beforeEach(async () => {
        const { worldCreator, worldsManager } = components

        deployer = await getIdentity()

        const created = await worldCreator.createWorldWithScene()
        worldName = created.worldName

        await worldsManager.storePermissions(worldName, {
          ...defaultPermissions(),
          deployment: {
            type: PermissionType.AllowList,
            wallets: [deployer.realAccount.address.toLowerCase()]
          }
        })
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

    describe('when the spawn coordinates do not belong to a deployed scene', () => {
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

      it('should respond with 400 validation error', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '99,99'
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: 'Invalid spawnCoordinates "99,99". It must belong to a parcel of a deployed scene.'
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

      describe('and spawn_coordinates has negative values', () => {
        it('should respond with 400 validation error since coordinates do not belong to a deployed scene', async () => {
          const { localFetch } = components

          const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
            spawn_coordinates: '-5,-10'
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Invalid spawnCoordinates "-5,-10". It must belong to a parcel of a deployed scene.'
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

        await worldsManager.storePermissions(worldName, defaultPermissions())

        stubComponents.namePermissionChecker.checkPermission
          .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
          .resolves(true)
      })

      it('should respond with 400 validation error since there are no scenes to set spawn to', async () => {
        const { localFetch } = components

        const response = await makeSignedRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '10,20'
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: 'Invalid spawnCoordinates "10,20". It must belong to a parcel of a deployed scene.'
        })
      })
    })
  })
})
