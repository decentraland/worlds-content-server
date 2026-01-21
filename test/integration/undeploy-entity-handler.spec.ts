import { test } from '../components'
import { getIdentity } from '../utils'
import { IAuthenticatedFetchComponent } from '../../src/types'

const BUILDER_METADATA = {
  origin: 'https://builder.decentraland.org',
  intent: 'dcl:builder:undeploy',
  signer: 'dcl:builder',
  isGuest: 'false'
}

test('undeploy entity handler /entities/:world_name', function ({ components, stubComponents }) {
  let localFetch: IAuthenticatedFetchComponent

  beforeEach(() => {
    localFetch = components.localFetch
  })

  it('gets user has no permission', async () => {
    const { worldCreator } = components

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene({})

    const r = await localFetch.fetch(`/entities/${worldName}`, {
      method: 'DELETE',
      identity,
      metadata: BUILDER_METADATA
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: 'Invalid request. You must have world-wide deployment permission to undeploy the entire world.'
    })
  })

  it('cannot undeploy if signer is sdk', async () => {
    const { worldCreator } = components

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene({
      owner: identity.authChain
    })

    const r = await localFetch.fetch(`/entities/${worldName}`, {
      method: 'DELETE',
      identity,
      metadata: { ...BUILDER_METADATA, signer: 'decentraland-kernel-scene' }
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

    const r = await localFetch.fetch(`/entities/${worldName}`, {
      method: 'DELETE',
      identity,
      metadata: BUILDER_METADATA
    })

    expect(r.status).toEqual(200)

    const entities = await components.worldsManager.getEntityForWorlds([worldName])
    expect(entities.length).toEqual(0)
  })
})
