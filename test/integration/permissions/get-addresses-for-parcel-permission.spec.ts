import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { IAuthenticatedFetchComponent } from '../../components/local-auth-fetch'
import { IPermissionsManager, IWorldCreator } from '../../../src/types'
import { IPermissionsComponent } from '../../../src/logic/permissions'

test('POST /world/:world_name/permissions/:permission_name/parcels', ({ components, stubComponents }) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let permissions: IPermissionsComponent
  let permissionsManager: IPermissionsManager

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
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

  describe('when the permission name is invalid', () => {
    it('should respond with a 400 and the error', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions/invalid/parcels`, {
        method: 'POST',
        body: JSON.stringify({ parcels: ['0,0'] }),
        headers: { 'Content-Type': 'application/json' }
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.message).toContain('does not support allow-list')
    })
  })

  describe('when the permission name is "access"', () => {
    it('should respond with a 400 and the error', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions/access/parcels`, {
        method: 'POST',
        body: JSON.stringify({ parcels: ['0,0'] }),
        headers: { 'Content-Type': 'application/json' }
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.message).toContain('does not support allow-list')
    })
  })

  describe('when there are no addresses with permission for the parcels', () => {
    it('should respond with 200, an empty list and total 0', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/parcels`, {
        method: 'POST',
        body: JSON.stringify({ parcels: ['0,0'] }),
        headers: { 'Content-Type': 'application/json' }
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ total: 0, addresses: [] })
    })
  })

  describe('when there is a world-wide deployer', () => {
    let worldWideWallet: string

    beforeEach(async () => {
      worldWideWallet = '0xD9370c94253f080272BA1c28E216146ecE806d33'
      await permissions.grantWorldWidePermission(worldName, 'deployment', [worldWideWallet])
    })

    it('should include the world-wide deployer for any parcel', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/parcels`, {
        method: 'POST',
        body: JSON.stringify({ parcels: ['99,99'] }),
        headers: { 'Content-Type': 'application/json' }
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.total).toBe(1)
      expect(body.addresses).toContain(worldWideWallet.toLowerCase())
    })
  })

  describe('when there is a parcel-specific deployer', () => {
    let parcelWallet: string

    beforeEach(async () => {
      parcelWallet = '0xb7DF441676bf3bDb13ad622ADE983d84f86B0df4'
      await permissionsManager.addParcelsToPermission(worldName, 'deployment', parcelWallet, ['0,0', '1,0'])
    })

    describe('and one of the queried parcels matches', () => {
      it('should include the parcel-specific deployer', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/parcels`, {
          method: 'POST',
          body: JSON.stringify({ parcels: ['0,0', '99,99'] }),
          headers: { 'Content-Type': 'application/json' }
        })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.total).toBe(1)
        expect(body.addresses).toContain(parcelWallet.toLowerCase())
      })
    })

    describe('and none of the queried parcels match', () => {
      it('should not include the parcel-specific deployer', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/parcels`, {
          method: 'POST',
          body: JSON.stringify({ parcels: ['99,99'] }),
          headers: { 'Content-Type': 'application/json' }
        })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.total).toBe(0)
        expect(body.addresses).toEqual([])
      })
    })
  })

  describe('when there are both world-wide and parcel-specific deployers', () => {
    let worldWideWallet: string
    let parcelWallet: string

    beforeEach(async () => {
      worldWideWallet = '0xD9370c94253f080272BA1c28E216146ecE806d33'
      parcelWallet = '0xb7DF441676bf3bDb13ad622ADE983d84f86B0df4'

      await permissions.grantWorldWidePermission(worldName, 'deployment', [worldWideWallet])
      await permissionsManager.addParcelsToPermission(worldName, 'deployment', parcelWallet, ['0,0'])
    })

    it('should include both addresses for a matching parcel', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/parcels`, {
        method: 'POST',
        body: JSON.stringify({ parcels: ['0,0'] }),
        headers: { 'Content-Type': 'application/json' }
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.total).toBe(2)
      expect(body.addresses).toEqual(
        expect.arrayContaining([worldWideWallet.toLowerCase(), parcelWallet.toLowerCase()])
      )
    })

    it('should include only the world-wide address for a non-matching parcel', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/parcels`, {
        method: 'POST',
        body: JSON.stringify({ parcels: ['99,99'] }),
        headers: { 'Content-Type': 'application/json' }
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.total).toBe(1)
      expect(body.addresses).toEqual([worldWideWallet.toLowerCase()])
    })
  })

  describe('when pagination parameters are provided', () => {
    let wallets: string[]

    beforeEach(async () => {
      wallets = [
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
        '0x3333333333333333333333333333333333333333'
      ]

      await Promise.all(
        wallets.map((wallet) => permissionsManager.addParcelsToPermission(worldName, 'deployment', wallet, ['0,0']))
      )
    })

    describe('and a limit is provided', () => {
      it('should return at most that many addresses', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/parcels?limit=2`, {
          method: 'POST',
          body: JSON.stringify({ parcels: ['0,0'] }),
          headers: { 'Content-Type': 'application/json' }
        })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.total).toBe(3)
        expect(body.addresses).toHaveLength(2)
      })
    })

    describe('and a limit with an offset are provided', () => {
      it('should return the remaining addresses after the offset', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/parcels?limit=2&offset=2`, {
          method: 'POST',
          body: JSON.stringify({ parcels: ['0,0'] }),
          headers: { 'Content-Type': 'application/json' }
        })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.total).toBe(3)
        expect(body.addresses).toHaveLength(1)
      })
    })
  })

  describe('when querying streaming permissions', () => {
    let streamingWallet: string

    beforeEach(async () => {
      streamingWallet = '0xD9370c94253f080272BA1c28E216146ecE806d33'
      await permissionsManager.addParcelsToPermission(worldName, 'streaming', streamingWallet, ['5,5'])
    })

    it('should return addresses for streaming permission', async () => {
      const response = await localFetch.fetch(`/world/${worldName}/permissions/streaming/parcels`, {
        method: 'POST',
        body: JSON.stringify({ parcels: ['5,5'] }),
        headers: { 'Content-Type': 'application/json' }
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.total).toBe(1)
      expect(body.addresses).toContain(streamingWallet.toLowerCase())
    })
  })
})
