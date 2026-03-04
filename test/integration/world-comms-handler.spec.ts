import { test } from '../components'
import { getIdentity, Identity } from '../utils'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'
import { IWorldsManager } from '../../src/types'
import { AccessType } from '../../src/logic/access'

const EXPLORER_METADATA = {
  origin: 'https://play.decentraland.org',
  intent: 'dcl:explorer:comms-handshake',
  signer: 'dcl:explorer',
  isGuest: 'false'
}

test('world comms handler', function ({ components, stubComponents }) {
  describe('when requesting a world room connection', () => {
    let localFetch: IAuthenticatedFetchComponent
    let worldsManager: IWorldsManager
    let identity: Identity
    let worldName: string

    beforeEach(async () => {
      localFetch = components.localFetch
      worldsManager = components.worldsManager
      identity = await getIdentity()

      const { worldCreator } = components
      const { namePermissionChecker } = stubComponents

      namePermissionChecker.checkPermission.resolves(true)

      const created = await worldCreator.createWorldWithScene()
      worldName = created.worldName
    })

    describe('and the request is valid', () => {
      it('should respond with 200 and the connection string', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
        expect(await r.json()).toEqual({
          fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/world-${worldName}`
        })
      })
    })

    describe('and the world does not exist', () => {
      let nonExistentWorld: string

      beforeEach(() => {
        const { worldCreator } = components
        nonExistentWorld = worldCreator.randomWorldName()
      })

      it('should respond with 404 and the invalid world error', async () => {
        const r = await localFetch.fetch(`/worlds/${nonExistentWorld}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(404)
        const body = await r.json()
        expect(body.error).toContain('invalid or blocked')
      })
    })

    describe('and the user has neither permission nor access', () => {
      beforeEach(async () => {
        const { namePermissionChecker } = stubComponents

        namePermissionChecker.checkPermission.resolves(false)

        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [],
          communities: []
        })
      })

      it('should respond with 401 and the not-allowed error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('not allowed to access')
      })
    })

    describe('and the user does not have access but has permission', () => {
      beforeEach(async () => {
        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [],
          communities: []
        })
      })

      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the user is on the allow list', () => {
      beforeEach(async () => {
        const { namePermissionChecker } = stubComponents

        namePermissionChecker.checkPermission.resolves(false)

        const userAddress = identity.authChain.authChain[0].payload.toLowerCase()
        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [userAddress],
          communities: []
        })
      })

      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the user is denylisted', () => {
      beforeEach(() => {
        const { denyList } = stubComponents as any
        denyList.isDenylisted.resolves(true)
      })

      it('should respond with 401 and the deny-listed error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('deny-listed')
      })
    })

    describe('and the world has been undeployed but the world record still exists', () => {
      beforeEach(async () => {
        await worldsManager.undeployWorld(worldName)
      })

      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the request is not signed', () => {
      it('should respond with 400 and the signed-fetch error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST'
        })

        expect(r.status).toEqual(400)
        expect(await r.json()).toEqual({
          error: 'Invalid Auth Chain',
          message: 'This endpoint requires a signed fetch request. See ADR-44.'
        })
      })
    })

    describe('and the signed-fetch metadata has a kernel-scene signer', () => {
      it('should respond with 400', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: {
            ...EXPLORER_METADATA,
            signer: 'decentraland-kernel-scene'
          }
        })

        expect(r.status).toEqual(400)
      })
    })
  })

  describe('when requesting a scene room connection', () => {
    let localFetch: IAuthenticatedFetchComponent
    let worldsManager: IWorldsManager
    let identity: Identity
    let worldName: string
    let entityId: string

    beforeEach(async () => {
      localFetch = components.localFetch
      worldsManager = components.worldsManager
      identity = await getIdentity()

      const { worldCreator } = components
      const { namePermissionChecker } = stubComponents

      namePermissionChecker.checkPermission.resolves(true)

      const created = await worldCreator.createWorldWithScene()
      worldName = created.worldName
      entityId = created.entityId
    })

    describe('and the request is valid', () => {
      it('should respond with 200 and the scene-specific connection string', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
        expect(await r.json()).toEqual({
          fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/scene-${worldName}-${entityId}`
        })
      })
    })

    describe('and the scene does not exist in the world', () => {
      it('should respond with 404 and the not-found error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/non-existent-scene-id/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(404)
        const body = await r.json()
        expect(body.error).toContain('not found')
      })
    })

    describe('and the world does not exist', () => {
      let nonExistentWorld: string

      beforeEach(() => {
        const { worldCreator } = components
        nonExistentWorld = worldCreator.randomWorldName()
      })

      it('should respond with 404 and the invalid world error', async () => {
        const r = await localFetch.fetch(`/worlds/${nonExistentWorld}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(404)
        const body = await r.json()
        expect(body.error).toContain('invalid or blocked')
      })
    })

    describe('and the user has neither permission nor access', () => {
      beforeEach(async () => {
        const { namePermissionChecker } = stubComponents

        namePermissionChecker.checkPermission.resolves(false)

        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [],
          communities: []
        })
      })

      it('should respond with 401 and the not-allowed error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('not allowed to access')
      })
    })

    describe('and the user is banned from the scene', () => {
      beforeEach(() => {
        const { bans } = stubComponents as any
        bans.isUserBannedFromScene.resolves(true)
      })

      it('should respond with 401 and the banned error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('banned')
      })
    })

    describe('and the scene was recently undeployed', () => {
      beforeEach(async () => {
        await worldsManager.undeployWorld(worldName)
      })

      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the request is not signed', () => {
      it('should respond with 400 and the signed-fetch error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST'
        })

        expect(r.status).toEqual(400)
        expect(await r.json()).toEqual({
          error: 'Invalid Auth Chain',
          message: 'This endpoint requires a signed fetch request. See ADR-44.'
        })
      })
    })
  })
})
