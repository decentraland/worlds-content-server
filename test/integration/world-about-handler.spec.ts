import { test } from '../components'
import { getIdentity, storeJson } from '../utils'
import { Authenticator } from '@dcl/crypto'

const ENTITY_CID = 'bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y'
const ENS = 'some-name.dcl.eth'

test('world about handler /world/:world_name/about', function ({ components }) {
  it('when world is not yet deployed it responds 404', async () => {
    const { localFetch } = components
    const r = await localFetch.fetch(`/world/${ENS}/about`)
    expect(r.status).toEqual(404)
  })
})

test('world about handler /world/:world_name/about', function ({ components }) {
  it('when world is not yet deployed but ACL exists it responds 404', async () => {
    const { localFetch, storage } = components

    const delegatedIdentity = await getIdentity()
    const ownerIdentity = await getIdentity()

    const payload = `{"resource":"my-world.dcl.eth","allowed":["${delegatedIdentity.realAccount.address}"]}`

    await storeJson(storage, 'name-my-world.dcl.eth', {
      acl: Authenticator.signPayload(ownerIdentity.authChain, payload)
    })

    const r = await localFetch.fetch(`/world/${ENS}/about`)
    expect(r.status).toEqual(404)
  })
})

test('world about handler /world/:world_name/about', function ({ components }) {
  it('when world exists it responds', async () => {
    const { localFetch, storage } = components

    await storeJson(storage, `name-${ENS}`, {
      entityId: ENTITY_CID,
      runtimeMetadata: {
        entityIds: [ENTITY_CID],
        minimapDataImage: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq',
        minimapEstateImage: undefined,
        minimapVisible: false,
        name: 'some-name.dcl.eth',
        skyboxTextures: ['bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq'],
        thumbnailFile: 'bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq'
      }
    })

    const r = await localFetch.fetch(`/world/${ENS}/about`)
    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      healthy: true,
      acceptingUsers: true,
      configurations: {
        networkId: 1,
        globalScenesUrn: [],
        scenesUrn: [`urn:decentraland:entity:${ENTITY_CID}?=&baseUrl=http://0.0.0.0:3000/contents/`],
        minimap: {
          enabled: false,
          dataImage: 'http://0.0.0.0:3000/contents/bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq'
        },
        skybox: {
          textures: ['http://0.0.0.0:3000/contents/bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq']
        },
        realmName: ENS
      },
      content: { healthy: true, publicUrl: 'https://peer.com/content' },
      lambdas: { healthy: true, publicUrl: 'https://peer.com/lambdas' },
      comms: {
        healthy: true,
        protocol: 'v3',
        fixedAdapter: `signed-login:http://0.0.0.0:3000/get-comms-adapter/world-${ENS}`
      }
    })
  })
})

test('world about handler /world/:world_name/about', function ({ components }) {
  it('when world exists and has minimap it responds', async () => {
    const { localFetch, storage } = components

    await storeJson(storage, 'name-some-name.dcl.eth', {
      entityId: ENTITY_CID,
      runtimeMetadata: {
        entityIds: [ENTITY_CID],
        minimapVisible: true,
        name: 'some-name.dcl.eth'
      }
    })

    const r = await localFetch.fetch('/world/some-name.dcl.eth/about')
    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject({
      configurations: {
        minimap: {
          enabled: true,
          dataImage: 'https://api.decentraland.org/v1/minimap.png',
          estateImage: 'https://api.decentraland.org/v1/estatemap.png'
        }
      }
    })

    await storeJson(storage, 'name-some-other-name.dcl.eth', {
      entityId: ENTITY_CID,
      runtimeMetadata: {
        entityIds: [ENTITY_CID],
        minimapVisible: false,
        name: 'some-name.dcl.eth',
        minimapDataImage: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq',
        minimapEstateImage: 'bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq'
      }
    })

    const r2 = await localFetch.fetch('/world/some-other-name.dcl.eth/about')
    expect(r2.status).toEqual(200)
    expect(await r2.json()).toMatchObject({
      configurations: {
        minimap: {
          enabled: false,
          dataImage: 'http://0.0.0.0:3000/contents/bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq',
          estateImage: 'http://0.0.0.0:3000/contents/bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq'
        }
      }
    })
  })
})

test('world about handler /world/:world_name/about', function ({ components }) {
  it('when world exists and has skybox textures it responds', async () => {
    const { localFetch, storage } = components

    await storeJson(storage, 'name-some-name.dcl.eth', {
      entityId: ENTITY_CID,
      runtimeMetadata: {
        entityIds: [ENTITY_CID],
        name: 'some-name.dcl.eth',
        skyboxTextures: ['bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq']
      }
    })

    const r = await localFetch.fetch('/world/some-name.dcl.eth/about')
    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject({
      configurations: {
        skybox: {
          textures: ['http://0.0.0.0:3000/contents/bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq']
        }
      }
    })
  })
})

test('world about handler /world/:world_name/about', function ({ components }) {
  it('when world exists and uses offline comms', async () => {
    const { localFetch, storage } = components

    await storeJson(storage, 'name-some-name.dcl.eth', {
      entityId: ENTITY_CID,
      runtimeMetadata: {
        entityIds: [ENTITY_CID],
        name: 'some-name.dcl.eth',
        fixedAdapter: 'offline:offline'
      }
    })

    const r = await localFetch.fetch('/world/some-name.dcl.eth/about')
    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject({
      comms: {
        healthy: true,
        protocol: 'v3',
        fixedAdapter: 'offline:offline'
      }
    })
  })
})

test('world about handler /world/:world_name/about', function ({ components }) {
  it('when world does not exist it responds with 404', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/world/missing-world.dcl.eth/about')
    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "missing-world.dcl.eth" has no scene deployed.` })
  })
})

test('world about handler /world/:world_name/about', function ({ components }) {
  it('when world exists but the scene does not, it responds with 404', async () => {
    const { localFetch, storage } = components

    await storeJson(storage, 'name-some-name.dcl.eth', {
      runtimeMetadata: {
        entityIds: [],
        name: 'some-name.dcl.eth'
      }
    })

    const r = await localFetch.fetch('/world/some-name.dcl.eth/about')
    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${ENS}" has no scene deployed.` })
  })
})

test('world about handler /world/:world_name/about', function ({ components, stubComponents }) {
  it('when name is deny-listed it responds 404', async () => {
    const { localFetch, storage } = components
    const { nameDenyListChecker } = stubComponents

    nameDenyListChecker.checkNameDenyList.withArgs(ENS.replace('.dcl.eth', '')).resolves(false)

    await storeJson(storage, `name-${ENS}`, {
      entityId: ENTITY_CID,
      runtimeMetadata: {
        entityIds: [ENTITY_CID],
        minimapDataImage: undefined,
        minimapEstateImage: undefined,
        minimapVisible: false,
        name: `${ENS}`,
        skyboxTextures: [],
        thumbnailFile: undefined
      }
    })

    const r = await localFetch.fetch(`/world/${ENS}/about`)
    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${ENS}" has no scene deployed.` })
  })
})
