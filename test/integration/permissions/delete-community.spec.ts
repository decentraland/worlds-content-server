import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { IAuthenticatedFetchComponent } from '../../components/local-auth-fetch'
import { IWorldCreator, IWorldsManager } from '../../../src/types'
import { AccessType, IAccessComponent } from '../../../src/logic/access'

const BUILDER_METADATA = {
  origin: 'https://builder.decentraland.org',
  intent: 'dcl:builder:change-permissions',
  signer: 'dcl:builder',
  isGuest: 'false'
}

const COMMUNITY_ID = 'test-community-id'

test('DELETE /world/:world_name/permissions/access/communities/:communityId', ({ components, stubComponents }) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let worldsManager: IWorldsManager
  let access: IAccessComponent

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    worldsManager = components.worldsManager
    access = components.access

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

  describe('when the world has allow-list access and the community is in the list', () => {
    let path: string

    beforeEach(async () => {
      path = `/world/${worldName}/permissions/access/communities/${COMMUNITY_ID}`

      await worldsManager.storeAccess(worldName, {
        type: AccessType.AllowList,
        wallets: [],
        communities: [COMMUNITY_ID, 'other-community']
      })
    })

    it('should respond with 204 and remove the community from the access allow list', async () => {
      const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

      expect(response.status).toBe(204)
      expect(await response.text()).toEqual('')

      const accessSetting = await access.getAccessForWorld(worldName)
      expect(accessSetting.type).toBe(AccessType.AllowList)
      if (accessSetting.type === AccessType.AllowList) {
        expect(accessSetting.communities).not.toContain(COMMUNITY_ID)
        expect(accessSetting.communities).toContain('other-community')
      }
    })
  })

  describe('when the community is not in the access allow list', () => {
    let path: string

    beforeEach(async () => {
      path = `/world/${worldName}/permissions/access/communities/${COMMUNITY_ID}`

      await worldsManager.storeAccess(worldName, {
        type: AccessType.AllowList,
        wallets: [],
        communities: ['other-community']
      })
    })

    it('should respond with 204 (idempotent operation)', async () => {
      const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

      expect(response.status).toBe(204)
    })
  })

  describe('when the world does not have allow-list access', () => {
    let path: string

    beforeEach(async () => {
      path = `/world/${worldName}/permissions/access/communities/${COMMUNITY_ID}`

      await worldsManager.storeAccess(worldName, {
        type: AccessType.Unrestricted
      })
    })

    it('should respond with 400 and a not allow-list error', async () => {
      const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

      expect(response.status).toEqual(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: expect.stringContaining('does not have allow-list access type')
      })
    })
  })

  describe('when the community id is only whitespace', () => {
    it('should respond with 400 and an invalid community id error', async () => {
      const response = await localFetch.fetch(
        `/world/${worldName}/permissions/access/communities/${encodeURIComponent('  ')}`,
        { method: 'DELETE', identity, metadata: BUILDER_METADATA }
      )

      expect(response.status).toEqual(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: 'Invalid community id.'
      })
    })
  })
})
