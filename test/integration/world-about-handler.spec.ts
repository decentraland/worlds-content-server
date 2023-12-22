import { test } from '../components'
import { getIdentity } from '../utils'
import { stringToUtf8Bytes } from 'eth-connect'
import { defaultPermissions } from '../../src/logic/permissions-checker'
import { PermissionType } from '../../src/types'
import SQL from 'sql-template-strings'

test('world about handler /world/:world_name/about', function ({ components, stubComponents }) {
  beforeEach(async () => {
    const { config } = stubComponents

    config.requireString.withArgs('ETH_NETWORK').resolves('mainnet')
    config.requireString.withArgs('COMMS_ROOM_PREFIX').resolves('world-')
  })

  it('when world is not yet deployed it responds 404', async () => {
    const { localFetch, worldCreator } = components
    const r = await localFetch.fetch(`/world/${worldCreator.randomWorldName()}/about`)
    expect(r.status).toEqual(404)
  })

  it('when world is not yet deployed but ACL exists it responds 404', async () => {
    const { localFetch, worldsManager, worldCreator } = components

    const delegatedIdentity = await getIdentity()

    const worldName = worldCreator.randomWorldName()
    await worldsManager.storePermissions(worldName, {
      ...defaultPermissions(),
      deployment: {
        type: PermissionType.AllowList,
        wallets: [delegatedIdentity.realAccount.address]
      }
    })
    const r = await localFetch.fetch(`/world/${worldName}/about`)
    expect(r.status).toEqual(404)
  })

  it('when world exists it responds', async () => {
    const { localFetch, worldCreator } = components

    const worldName = worldCreator.randomWorldName()
    const files = new Map<string, Uint8Array>()
    files.set('abc.png', Buffer.from(stringToUtf8Bytes('Hello world')))

    const { entityId, entity } = await worldCreator.createWorldWithScene({
      worldName: worldName,
      metadata: {
        main: 'abc.txt',
        scene: {
          base: '20,24',
          parcels: ['20,24']
        },
        worldConfiguration: {
          name: worldName,
          miniMapConfig: {
            dataImage: 'abc.png'
          },
          skyboxConfig: {
            textures: ['abc.png']
          }
        }
      },
      files: files
    })

    const r = await localFetch.fetch(`/world/${worldName}/about`)

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

  it('when world exists and has minimap it responds', async () => {
    const { localFetch, worldCreator } = components

    // minimap with default images
    {
      const worldName = worldCreator.randomWorldName()
      await worldCreator.createWorldWithScene({
        worldName: worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24']
          },
          worldConfiguration: {
            name: worldName,
            miniMapConfig: {
              visible: true
            }
          }
        }
      })

      const r = await localFetch.fetch(`/world/${worldName}/about`)

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
    }

    // minimap with dataImage and estateImage
    {
      const files = new Map<string, Uint8Array>()
      files.set('abc.png', Buffer.from(stringToUtf8Bytes('Hello world')))
      files.set('def.png', Buffer.from(stringToUtf8Bytes('Bye bye world')))
      const worldName = worldCreator.randomWorldName()
      const { entity } = await worldCreator.createWorldWithScene({
        worldName: worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24']
          },
          worldConfiguration: {
            name: worldName,
            miniMapConfig: {
              dataImage: 'abc.png',
              estateImage: 'def.png'
            }
          }
        },
        files
      })

      const r2 = await localFetch.fetch(`/world/${worldName}/about`)
      expect(r2.status).toEqual(200)
      expect(await r2.json()).toMatchObject({
        configurations: {
          minimap: {
            enabled: false,
            dataImage: `http://0.0.0.0:3000/contents/${entity.content[0].hash}`,
            estateImage: `http://0.0.0.0:3000/contents/${entity.content[1].hash}`
          }
        }
      })
    }
  })

  it('when world exists and has skybox textures it responds', async () => {
    const { localFetch, worldCreator } = components

    const worldName = worldCreator.randomWorldName()
    const files = new Map<string, Uint8Array>()
    files.set('abc.png', Buffer.from(stringToUtf8Bytes('Hello world')))

    const { entity } = await worldCreator.createWorldWithScene({
      worldName: worldName,
      metadata: {
        main: 'abc.txt',
        scene: {
          base: '20,24',
          parcels: ['20,24']
        },
        worldConfiguration: {
          name: worldName,
          skyboxConfig: {
            textures: ['abc.png']
          }
        }
      },
      files: files
    })

    const r = await localFetch.fetch(`/world/${worldName}/about`)
    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject({
      configurations: {
        skybox: {
          textures: [`http://0.0.0.0:3000/contents/${entity.content[0].hash}`]
        }
      }
    })
  })

  it('when world exists and uses offline comms', async () => {
    const { localFetch, worldCreator } = components

    const worldName = worldCreator.randomWorldName()
    await worldCreator.createWorldWithScene({
      worldName: worldName,
      metadata: {
        main: 'abc.txt',
        scene: {
          base: '20,24',
          parcels: ['20,24']
        },
        worldConfiguration: {
          name: worldName,
          fixedAdapter: 'offline:offline'
        }
      }
    })

    const r = await localFetch.fetch(`/world/${worldName}/about`)
    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject({
      comms: {
        healthy: true,
        protocol: 'v3',
        adapter: 'fixed-adapter:offline:offline'
      }
    })
  })

  it('when world does not exist it responds with 404', async () => {
    const { localFetch, worldCreator } = components

    const worldName = worldCreator.randomWorldName()

    const r = await localFetch.fetch(`/world/${worldName}/about`)
    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${worldName}" has no scene deployed.` })
  })

  it('when world exists but with no scene deployed, it responds with 404', async () => {
    const { localFetch, worldCreator, worldsManager } = components

    const worldName = worldCreator.randomWorldName()

    const delegatedIdentity = await getIdentity()

    await worldsManager.storePermissions(worldName, {
      ...defaultPermissions(),
      deployment: {
        type: PermissionType.AllowList,
        wallets: [delegatedIdentity.realAccount.address]
      }
    })
    const r = await localFetch.fetch(`/world/${worldName}/about`)
    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${worldName}" has no scene deployed.` })
  })

  it('when name is deny-listed it responds 404', async () => {
    const { localFetch, worldCreator } = components
    const { nameDenyListChecker } = stubComponents

    const { worldName } = await worldCreator.createWorldWithScene()

    nameDenyListChecker.checkNameDenyList.withArgs(worldName).resolves(false)

    const r = await localFetch.fetch(`/world/${worldName}/about`)
    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${worldName}" has no scene deployed.` })
  })

  it('when world exists but the wallet is blocked it responds with 403', async () => {
    const { database, localFetch, worldCreator } = components
    const { nameDenyListChecker } = stubComponents

    const identity = await getIdentity()
    const { worldName } = await worldCreator.createWorldWithScene({
      owner: identity.authChain
    })

    const blockedSince = new Date()
    blockedSince.setDate(blockedSince.getDate() - 3)
    await database.query(SQL`
        INSERT INTO blocked (wallet, created_at, updated_at)
            VALUES (${identity.realAccount.address.toLowerCase()}, ${blockedSince}, ${new Date()})
        `)

    nameDenyListChecker.checkNameDenyList.withArgs(worldName).resolves(true)

    const r = await localFetch.fetch(`/world/${worldName}/about`)
    expect(r.status).toEqual(401)
    expect(await r.json()).toMatchObject({
      error: 'Not Authorized',
      message: expect.any(String)
    })
  })
})
