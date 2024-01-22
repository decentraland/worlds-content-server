import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'

test('reprocess asset-bundles handler /reprocess-ab', function ({ components, stubComponents }) {
  beforeEach(async () => {
    const { config } = stubComponents

    config.requireString.withArgs('AUTH_SECRET').resolves('some-secret')
  })

  it('when world exists it responds', async () => {
    const { localFetch, worldCreator } = components

    const worldName = worldCreator.randomWorldName()
    const files = new Map<string, Uint8Array>()
    files.set('abc.png', Buffer.from(stringToUtf8Bytes('Hello world')))

    const { entityId, entity } = await worldCreator.createWorldWithScene({})

    const r = await localFetch.fetch(`/reprocess-ab`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer some-secret'
      }
    })

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      healthy: true,
      acceptingUsers: true,
      configurations: {
        networkId: 1,
        globalScenesUrn: [],
        scenesUrn: [`urn:decentraland:entity:${entityId}?=&baseUrl=http://0.0.0.0:3000/contents/`],
        minimap: {
          enabled: false,
          dataImage: `http://0.0.0.0:3000/contents/${entity.content[0].hash}`
        },
        skybox: {
          textures: [`http://0.0.0.0:3000/contents/${entity.content[0].hash}`]
        },
        realmName: worldName
      },
      content: {
        healthy: true,
        publicUrl: 'https://peer.com/content',
        synchronizationStatus: 'Syncing'
      },
      lambdas: { healthy: true, publicUrl: 'https://peer.com/lambdas' },
      comms: {
        healthy: true,
        protocol: 'v3',
        adapter: `fixed-adapter:signed-login:http://0.0.0.0:3000/get-comms-adapter/world-${worldName}`
      }
    })
  })
})
