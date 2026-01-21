import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { IAuthenticatedFetchComponent, IPermissionsManager, IWorldCreator, IWorldsManager } from '../../../src/types'
import bcrypt from 'bcrypt'
import { defaultPermissions, IPermissionsComponent, PermissionType } from '../../../src/logic/permissions'
import { AccessType } from '../../../src/logic/access'

test('GET /world/:world_name/permissions', ({ components, stubComponents }) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let worldsManager: IWorldsManager
  let permissions: IPermissionsComponent
  let permissionsManager: IPermissionsManager

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    worldsManager = components.worldsManager
    permissions = components.permissions
    permissionsManager = components.permissionsManager

    identity = await getIdentity()

    const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
    worldName = created.worldName

    stubComponents.namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
      .resolves(true)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the world does not exist', () => {
    let nonExistentWorldName: string

    beforeEach(() => {
      nonExistentWorldName = worldCreator.randomWorldName()
    })

    it('should respond with 200 and default permissions', async () => {
      const response = await localFetch.fetch(`/world/${nonExistentWorldName}/permissions`)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.permissions).toMatchObject({
        deployment: defaultPermissions().deployment,
        streaming: { type: PermissionType.Unrestricted },
        access: { type: AccessType.Unrestricted }
      })
    })
  })

  describe('when the world exists with access settings', () => {
    beforeEach(async () => {
      await worldsManager.storeAccess(worldName, {
        type: AccessType.SharedSecret,
        secret: bcrypt.hashSync('some-super-secret-password', 10)
      })
    })

    it('should respond with 200 and the access settings without the secret', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions`)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.permissions.access).toMatchObject({
        type: AccessType.SharedSecret
      })
      expect(body.permissions.access.secret).toBeUndefined()
    })
  })

  describe('when the world exists with streaming permissions', () => {
    let streamingWallet1: string
    let streamingWallet2: string

    beforeEach(async () => {
      streamingWallet1 = '0xD9370c94253f080272BA1c28E216146ecE806d33'
      streamingWallet2 = '0xb7DF441676bf3bDb13ad622ADE983d84f86B0df4'

      await permissions.grantWorldWidePermission(worldName, 'streaming', [streamingWallet1, streamingWallet2])
    })

    it('should respond with 200 and include the streaming wallets', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions`)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.permissions.streaming).toMatchObject({
        type: PermissionType.AllowList,
        wallets: expect.arrayContaining([streamingWallet1.toLowerCase(), streamingWallet2.toLowerCase()])
      })
    })
  })

  describe('when the world exists with deployment permissions', () => {
    let worldWideWallet: string
    let parcelWallet: string
    let parcels: string[]

    beforeEach(async () => {
      worldWideWallet = '0xD9370c94253f080272BA1c28E216146ecE806d33'
      parcelWallet = '0xb7DF441676bf3bDb13ad622ADE983d84f86B0df4'
      parcels = ['0,0', '1,0', '1,1']

      await permissions.grantWorldWidePermission(worldName, 'deployment', [worldWideWallet])
      await permissionsManager.addParcelsToPermission(worldName, 'deployment', parcelWallet, parcels)
    })

    it('should respond with 200 and include both world-wide and parcel-based deployers', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions`)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.permissions.deployment).toMatchObject({
        type: PermissionType.AllowList
      })
      expect(body.permissions.deployment.wallets).toEqual(
        expect.arrayContaining([worldWideWallet.toLowerCase(), parcelWallet.toLowerCase()])
      )
    })
  })

  describe('when the world exists with an owner', () => {
    let createdWorld: { worldName: string; owner: any }

    beforeEach(async () => {
      createdWorld = await worldCreator.createWorldWithScene()

      await worldsManager.storeAccess(createdWorld.worldName, {
        type: AccessType.SharedSecret,
        secret: bcrypt.hashSync('some-super-secret-password', 10)
      })
    })

    it('should respond with 200 and include the owner in the response', async () => {
      const response = await localFetch.fetch(`/world/${createdWorld.worldName}/permissions`)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.owner).toBe(createdWorld.owner.authChain[0].payload.toLowerCase())
      expect(body.permissions.access.secret).toBeUndefined()
    })
  })
})
