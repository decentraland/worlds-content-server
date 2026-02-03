import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { IAuthenticatedFetchComponent } from '../../components/local-auth-fetch'
import { IPermissionsManager, IWorldCreator } from '../../../src/types'
import { IPermissionsComponent } from '../../../src/logic/permissions'

test('GET /world/:world_name/permissions/:permission_name/address/:address/parcels', ({
  components,
  stubComponents
}) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let permissionsManager: IPermissionsManager
  let permissions: IPermissionsComponent

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    permissionsManager = components.permissionsManager
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

  describe('when the address has parcels', () => {
    let targetAddress: Identity
    let existingParcels: string[]
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      existingParcels = ['0,0', '1,0', '1,1', '2,2', '3,3']
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`

      await permissionsManager.addParcelsToPermission(
        worldName,
        'deployment',
        targetAddress.realAccount.address,
        existingParcels
      )
    })

    it('should respond with 200 and return all parcels with the total count', async () => {
      const response = await localFetch.fetch(path)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.total).toBe(5)
      expect(body.parcels).toEqual(expect.arrayContaining(existingParcels))
    })

    describe('and pagination is used', () => {
      let paginatedPath: string

      beforeEach(() => {
        paginatedPath = `${path}?limit=2&offset=0`
      })

      it('should respond with 200 and return paginated results with total count', async () => {
        const response = await localFetch.fetch(paginatedPath)

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.total).toBe(5)
        expect(body.parcels.length).toBe(2)
      })
    })

    describe('and bounding box is used', () => {
      let boundingBoxPath: string

      beforeEach(() => {
        boundingBoxPath = `${path}?x1=0&y1=0&x2=1&y2=1`
      })

      it('should respond with 200 and return only parcels within the bounding box', async () => {
        const response = await localFetch.fetch(boundingBoxPath)

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.total).toBe(3)
        expect(body.parcels).toEqual(expect.arrayContaining(['0,0', '1,0', '1,1']))
      })
    })

    describe('and partial bounding box is provided', () => {
      let partialBoundingBoxPath: string

      beforeEach(() => {
        partialBoundingBoxPath = `${path}?x1=0&y1=0`
      })

      it('should respond with 400 and a bounding box validation error', async () => {
        const response = await localFetch.fetch(partialBoundingBoxPath)

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: 'Bounding box requires all four parameters: x1, y1, x2, y2.'
        })
      })
    })
  })

  describe('when the address has world-wide permission', () => {
    let targetAddress: Identity
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`

      await permissions.grantWorldWidePermission(worldName, 'deployment', [targetAddress.realAccount.address])
    })

    it('should respond with 200 and return an empty parcels list with total 0', async () => {
      const response = await localFetch.fetch(path)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.total).toBe(0)
      expect(body.parcels).toEqual([])
    })
  })

  describe('when the address does not have permission', () => {
    let targetAddress: Identity
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`
    })

    it('should respond with 404 and a permission not found error', async () => {
      const response = await localFetch.fetch(path)

      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        error: 'Not Found',
        message: `Address ${targetAddress.realAccount.address} does not have deployment permission for world ${worldName}.`
      })
    })
  })

  describe('when the address is invalid', () => {
    let path: string

    beforeEach(() => {
      path = `/world/${worldName}/permissions/deployment/address/invalid-address/parcels`
    })

    it('should respond with 400 and an invalid address error', async () => {
      const response = await localFetch.fetch(path)

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: 'Invalid address: invalid-address.'
      })
    })
  })

  describe('when the permission name is invalid', () => {
    let targetAddress: Identity
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      path = `/world/${worldName}/permissions/invalid/address/${targetAddress.realAccount.address}/parcels`
    })

    it('should respond with 400 and an invalid permission error', async () => {
      const response = await localFetch.fetch(path)

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: "Permission 'invalid' does not support allow-list. Only 'deployment' and 'streaming' do."
      })
    })
  })
})
