import { test } from '../components'
import { getAuthHeaders, getIdentity, Identity } from '../utils'
import { Authenticator } from '@dcl/crypto'

test('undeploy entity handler /entities/:world_name', function ({ components, stubComponents }) {
  function makeRequest(path: string, identity: Identity, metadata: Record<string, any> = {}) {
    const { localFetch } = components

    return localFetch.fetch(path, {
      method: 'DELETE',
      headers: {
        ...getAuthHeaders('DELETE', path, metadata, (payload) =>
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

  it('gets user has no permission', async () => {
    const { worldCreator } = components

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene({})

    const r = await makeRequest(`/entities/${worldName}`, identity)

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({ message: 'Invalid request. You have no permission to undeploy the scene.' })
  })

  it('cannot undeploy if signer is sdk', async () => {
    const { worldCreator } = components

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene({
      owner: identity.authChain
    })

    const r = await makeRequest(`/entities/${worldName}`, identity, {
      signer: 'decentraland-kernel-scene'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({ message: 'This endpoint requires a signed fetch request. See ADR-44.' })
  })

  it('successfully un-deploys a world', async () => {
    const { worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene({
      owner: identity.authChain
    })

    namePermissionChecker.checkPermission.withArgs(identity.realAccount.address.toLowerCase(), worldName).resolves(true)

    const r = await makeRequest(`/entities/${worldName}`, identity)

    expect(r.status).toEqual(200)

    const entities = await components.worldsManager.getEntityForWorlds([worldName])
    expect(entities.length).toEqual(0)
  })
})
