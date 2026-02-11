import { Events } from '@dcl/schemas'
import { test } from '../components'
import { getIdentity } from '../utils'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'

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

  it('successfully undeploys a world and publishes a WorldUndeploymentEvent', async () => {
    const { worldCreator } = components
    const { namePermissionChecker, snsClient } = stubComponents

    const identity = await getIdentity()
    const { worldName } = await worldCreator.createWorldWithScene({
      owner: identity.authChain
    })

    namePermissionChecker.checkPermission.withArgs(identity.realAccount.address.toLowerCase(), worldName).resolves(true)
    snsClient.publishMessages.resolves({
      successfulMessageIds: ['msg-id'],
      failedEvents: []
    })

    const r = await localFetch.fetch(`/entities/${worldName}`, {
      method: 'DELETE',
      identity,
      metadata: BUILDER_METADATA
    })

    expect(r.status).toEqual(200)

    const entities = await components.worldsManager.getEntityForWorlds([worldName])
    expect(entities.length).toEqual(0)

    expect(snsClient.publishMessages.calledOnce).toBe(true)
    const call = snsClient.publishMessages.getCall(0)
    const events = call.args[0]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: Events.Type.WORLD,
      subType: Events.SubType.Worlds.WORLD_UNDEPLOYMENT,
      key: worldName,
      metadata: {
        worldName
      }
    })
  })
})
