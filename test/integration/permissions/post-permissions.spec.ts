import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { IAuthenticatedFetchComponent } from '../../components/local-auth-fetch'
import { IWorldCreator, IWorldsManager } from '../../../src/types'
import { IPermissionsComponent, PermissionType } from '../../../src/logic/permissions'
import { AccessType } from '../../../src/logic/access'

const BUILDER_METADATA = {
  origin: 'https://builder.decentraland.org',
  intent: 'dcl:builder:change-permissions',
  signer: 'dcl:builder',
  isGuest: 'false'
}

test('POST /world/:world_name/permissions/:permission_name', ({ components, stubComponents }) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let worldsManager: IWorldsManager
  let permissions: IPermissionsComponent

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    worldsManager = components.worldsManager
    permissions = components.permissions

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

  describe('when setting access permissions', () => {
    describe('and the type is unrestricted', () => {
      beforeEach(async () => {
        await worldsManager.storeAccess(worldName, {
          type: AccessType.SharedSecret,
          secret: 'hashed-secret'
        })
      })

      it('should respond with 204 and update the access to unrestricted', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: AccessType.Unrestricted }
        })

        expect(response.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata?.access).toMatchObject({
          type: AccessType.Unrestricted
        })
      })
    })

    describe('and the type is shared-secret with a valid secret', () => {
      it('should respond with 204 and store the hashed secret', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: AccessType.SharedSecret, secret: 'some-super-secret-password' }
        })

        expect(response.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata?.access).toMatchObject({
          type: AccessType.SharedSecret
        })
        expect((metadata?.access as any).secret).toMatch(/^\$2b\$10\$/)
      })
    })

    describe('and the type is allow-list', () => {
      it('should respond with 204 and set an empty wallet list', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: AccessType.AllowList }
        })

        expect(response.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata?.access).toMatchObject({
          type: AccessType.AllowList,
          wallets: []
        })
      })
    })

    describe('and the type is nft-ownership with a valid nft', () => {
      it('should respond with 204 and store the nft', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: AccessType.NFTOwnership, nft: 'urn:decentraland:some-nft' }
        })

        expect(response.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata?.access).toMatchObject({
          type: AccessType.NFTOwnership,
          nft: 'urn:decentraland:some-nft'
        })
      })
    })

    describe('and no type is provided', () => {
      it('should respond with 400 and an invalid type error', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, secret: 'some-super-secret-password' }
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: 'Invalid access type: undefined.'
        })
      })
    })

    describe('and an invalid type is provided', () => {
      it('should respond with 400 and an invalid type error', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: 'invalid', secret: 'some-super-secret-password' }
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: 'Invalid access type: invalid.'
        })
      })
    })

    describe('and the type is shared-secret but no secret is provided', () => {
      it('should respond with 400 and a missing secret error', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: AccessType.SharedSecret }
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: 'For shared secret there needs to be a valid secret.'
        })
      })
    })

    describe('and the type is nft-ownership but no nft is provided', () => {
      it('should respond with 400 and a missing nft error', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: AccessType.NFTOwnership }
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: 'For nft ownership there needs to be a valid nft.'
        })
      })
    })
  })

  describe('when setting deployment permissions', () => {
    describe('and the type is allow-list', () => {
      it('should respond with 204', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: PermissionType.AllowList }
        })

        expect(response.status).toBe(204)
      })
    })

    describe('and an invalid type is provided', () => {
      it('should respond with 400 and an invalid permission type error', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: AccessType.SharedSecret, secret: 'some-secret' }
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: `Invalid payload received. Deployment permission needs to be '${PermissionType.AllowList}'.`
        })
      })
    })
  })

  describe('when setting streaming permissions', () => {
    describe('and the type is allow-list', () => {
      it('should respond with 204', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/streaming`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: PermissionType.AllowList }
        })

        expect(response.status).toBe(204)
      })
    })

    describe('and the type is unrestricted', () => {
      beforeEach(async () => {
        await permissions.grantWorldWidePermission(worldName, 'streaming', [
          '0x1234567890123456789012345678901234567890'
        ])
      })

      it('should respond with 204 and remove all streaming permissions', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/streaming`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: PermissionType.Unrestricted }
        })

        expect(response.status).toBe(204)
      })
    })

    describe('and an invalid type is provided', () => {
      it('should respond with 400 and an invalid permission type error', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/streaming`, {
          method: 'POST',
          identity,
          metadata: { ...BUILDER_METADATA, type: AccessType.SharedSecret, secret: 'some-secret' }
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: `Invalid payload received. Streaming permission needs to be either '${PermissionType.Unrestricted}' or '${PermissionType.AllowList}'.`
        })
      })
    })
  })

  describe('when the caller is not the world owner', () => {
    let nonOwnerIdentity: Identity

    beforeEach(async () => {
      nonOwnerIdentity = await getIdentity()
    })

    it('should respond with 401 and a not authorized error', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions/streaming`, {
        method: 'POST',
        identity: nonOwnerIdentity,
        metadata: { ...BUILDER_METADATA, type: PermissionType.Unrestricted }
      })

      expect(response.status).toEqual(401)
      expect(await response.json()).toMatchObject({
        error: 'Not Authorized',
        message: `Your wallet does not own "${worldName}", you can not set access control lists for it.`
      })
    })
  })

  describe('when the request is not signed', () => {
    let path: string

    beforeEach(() => {
      path = `/world/${worldName}/permissions/access`
    })

    it('should respond with 400 and an invalid auth chain error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'POST'
      })

      expect(response.status).toEqual(400)
      expect(await response.json()).toMatchObject({
        error: 'Invalid Auth Chain',
        message: 'This endpoint requires a signed fetch request. See ADR-44.'
      })
    })
  })
})
