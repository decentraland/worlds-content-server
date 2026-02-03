import { test } from '../components'
import FormData from 'form-data'
import { getIdentity, Identity } from '../utils'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'
import { IPermissionsComponent } from '../../src/logic/permissions'
import { defaultAccess } from '../../src/logic/access'

const SETTINGS_METADATA = {
  origin: 'https://builder.decentraland.org',
  intent: 'dcl:builder:update-world-settings',
  signer: 'dcl:builder',
  isGuest: 'false'
}

const makeSignedMultipartRequest = (
  localFetch: IAuthenticatedFetchComponent,
  path: string,
  identity: Identity,
  fields: Record<string, string>,
  files?: Record<string, { buffer: Buffer; filename: string }>,
  method: string = 'PUT'
) => {
  const form = new FormData()

  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value)
  }

  if (files) {
    for (const [key, file] of Object.entries(files)) {
      form.append(key, file.buffer, { filename: file.filename })
    }
  }

  return localFetch.fetch(path, {
    method,
    identity,
    metadata: SETTINGS_METADATA,
    headers: form.getHeaders(),
    body: form
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
        const owner = created.owner.authChain[0].payload

        await worldsManager.updateWorldSettings(worldName, owner, { spawnCoordinates: '20,24' })
      })

      it('should return the world settings', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch(`/world/${worldName}/settings`)

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          spawn_coordinates: '20,24'
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
          spawn_coordinates: '20,24'
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

        const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '20,24'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'World settings updated successfully',
          settings: {
            spawn_coordinates: '20,24'
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

        const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, deployer, {
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

        const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
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

        const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
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

        const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '21,24'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'World settings updated successfully',
          settings: {
            spawn_coordinates: '21,24'
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
        const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
          spawn_coordinates: '21,25'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          message: 'World settings updated successfully',
          settings: {
            spawn_coordinates: '21,25'
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
        const form = new FormData()
        form.append('spawn_coordinates', '20,24')

        const response = await localFetch.fetch(`/world/${worldName}/settings`, {
          method: 'PUT',
          headers: form.getHeaders(),
          body: form
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

      describe('and at least one field is provided', () => {
        it('should succeed with 200 and only update the provided field', async () => {
          const { localFetch, worldsManager } = components

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            title: 'My World'
          })

          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({
            message: 'World settings updated successfully',
            settings: {
              title: 'My World'
            }
          })

          const settings = await worldsManager.getWorldSettings(worldName)
          expect(settings?.title).toBe('My World')
        })
      })

      describe('and title is too short', () => {
        it('should respond with 400 validation error', async () => {
          const { localFetch } = components

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            title: 'ab'
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Invalid title: ab. Expected between 3 and 100 characters.'
          })
        })
      })

      describe('and title is too long', () => {
        it('should respond with 400 validation error', async () => {
          const { localFetch } = components
          const longTitle = 'a'.repeat(101)

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            title: longTitle
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: `Invalid title: ${longTitle}. Expected between 3 and 100 characters.`
          })
        })
      })

      describe('and description is too short', () => {
        it('should respond with 400 validation error', async () => {
          const { localFetch } = components

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            description: 'ab'
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Invalid description: ab. Expected between 3 and 1000 characters.'
          })
        })
      })

      describe('and description is too long', () => {
        it('should respond with 400 validation error', async () => {
          const { localFetch } = components
          const longDescription = 'a'.repeat(1001)

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            description: longDescription
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: `Invalid description: ${longDescription}. Expected between 3 and 1000 characters.`
          })
        })
      })

      describe('and content_rating is invalid', () => {
        it('should respond with 400 validation error', async () => {
          const { localFetch } = components

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            content_rating: 'INVALID'
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Invalid content rating: INVALID. Expected one of: RP, E, T, A, R'
          })
        })
      })

      describe('and thumbnail exceeds maximum size', () => {
        it('should respond with 400 validation error', async () => {
          const { localFetch } = components

          // Create a buffer larger than 1MB
          const largeBuffer = Buffer.alloc(1024 * 1024 + 1) // 1MB + 1 byte

          const response = await makeSignedMultipartRequest(
            localFetch,
            `/world/${worldName}/settings`,
            identity,
            {},
            { thumbnail: { buffer: largeBuffer, filename: 'thumbnail.png' } }
          )

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: `Invalid thumbnail: size ${largeBuffer.length} bytes exceeds maximum of 1048576 bytes (1MB).`
          })
        })
      })

      describe('and spawn_coordinates has invalid format', () => {
        it('should respond with 400 validation error', async () => {
          const { localFetch } = components

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            spawn_coordinates: 'invalid'
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Invalid spawnCoordinates format: "invalid".'
          })
        })
      })

      describe('and spawn_coordinates has negative values outside the world shape', () => {
        it('should respond with 400 validation error since coordinates are outside the world shape rectangle', async () => {
          const { localFetch } = components

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            spawn_coordinates: '-5,-10'
          })

          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({
            error: 'Invalid spawnCoordinates "-5,-10". It must be within the world shape rectangle: (20,24) to (20,24).'
          })
        })
      })

      describe('and spawn_coordinates is an empty string', () => {
        it('should succeed with 200 since empty string is treated as no update', async () => {
          const { localFetch } = components

          const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
            spawn_coordinates: ''
          })

          // Empty string is treated as "no change" since all fields are optional
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({
            message: 'World settings updated successfully'
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

        const response = await makeSignedMultipartRequest(localFetch, `/world/${worldName}/settings`, identity, {
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
