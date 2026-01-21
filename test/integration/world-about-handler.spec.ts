import { test } from '../components'
import { getIdentity } from '../utils'
import { stringToUtf8Bytes } from 'eth-connect'
import { defaultAccess } from '../../src/logic/access'
import SQL from 'sql-template-strings'

test('world about handler /world/:world_name/about', function ({ components, stubComponents }) {
  beforeEach(async () => {
    const { config } = stubComponents

    config.requireString.withArgs('ETH_NETWORK').resolves('mainnet')
    config.requireString.withArgs('COMMS_ROOM_PREFIX').resolves('world-')
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the world does not exist', () => {
    let worldName: string

    beforeEach(() => {
      const { worldCreator } = components
      worldName = worldCreator.randomWorldName()
    })

    it('should respond with 404 status and an error message indicating no scenes are deployed', async () => {
      const { localFetch } = components

      const r = await localFetch.fetch(`/world/${worldName}/about`)

      expect(r.status).toEqual(404)
      expect(await r.json()).toMatchObject({ message: `World "${worldName}" has no scenes deployed.` })
    })
  })

  describe('when the world is not deployed but ACL exists', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator, worldsManager } = components
      const permissions = components.permissions

      const delegatedIdentity = await getIdentity()
      worldName = worldCreator.randomWorldName()

      // Create a world entry without deploying a scene
      await worldsManager.storeAccess(worldName, defaultAccess())
      // Grant deployment permission to the delegated identity
      await permissions.grantWorldWidePermission(worldName, 'deployment', [
        delegatedIdentity.realAccount.address.toLowerCase()
      ])
    })

    it('should respond with 404 status and an error message indicating no scenes are deployed', async () => {
      const { localFetch } = components

      const r = await localFetch.fetch(`/world/${worldName}/about`)

      expect(r.status).toEqual(404)
      expect(await r.json()).toMatchObject({ message: `World "${worldName}" has no scenes deployed.` })
    })
  })

  describe('when the world exists', () => {
    describe('and it has a deployed scene with minimap and skybox config', () => {
      let worldName: string
      let entityId: string
      let entityContent: { file: string; hash: string }[]

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
        const files = new Map<string, Uint8Array>()
        files.set('abc.png', Buffer.from(stringToUtf8Bytes('Hello world')))

        const result = await worldCreator.createWorldWithScene({
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

        entityId = result.entityId
        entityContent = result.entity.content
      })

      it('should respond with the complete world about information including spawnCoordinates', async () => {
        const { localFetch } = components

        const r = await localFetch.fetch(`/world/${worldName}/about`)

        expect(r.status).toEqual(200)
        expect(await r.json()).toEqual({
          healthy: true,
          acceptingUsers: true,
          spawnCoordinates: '20,24',
          configurations: {
            networkId: 1,
            globalScenesUrn: [],
            scenesUrn: [`urn:decentraland:entity:${entityId}?=&baseUrl=http://0.0.0.0:3000/contents/`],
            minimap: {
              enabled: false,
              dataImage: `http://0.0.0.0:3000/contents/${entityContent[0].hash}`
            },
            map: {
              minimapEnabled: false,
              sizes: []
            },
            skybox: {
              textures: [`http://0.0.0.0:3000/contents/${entityContent[0].hash}`]
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

    describe('and it has minimap with visible flag set to true', () => {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
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
      })

      it('should respond with 200 and minimap enabled with default images', async () => {
        const { localFetch } = components

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
      })
    })

    describe('and it has minimap with custom dataImage and estateImage', () => {
      let worldName: string
      let entityContent: { file: string; hash: string }[]

      beforeEach(async () => {
        const { worldCreator } = components

        const files = new Map<string, Uint8Array>()
        files.set('abc.png', Buffer.from(stringToUtf8Bytes('Hello world')))
        files.set('def.png', Buffer.from(stringToUtf8Bytes('Bye bye world')))

        worldName = worldCreator.randomWorldName()
        const result = await worldCreator.createWorldWithScene({
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

        entityContent = result.entity.content
      })

      it('should respond with 200 and minimap config using custom image URLs', async () => {
        const { localFetch } = components

        const r = await localFetch.fetch(`/world/${worldName}/about`)

        expect(r.status).toEqual(200)
        expect(await r.json()).toMatchObject({
          configurations: {
            minimap: {
              enabled: false,
              dataImage: `http://0.0.0.0:3000/contents/${entityContent[0].hash}`,
              estateImage: `http://0.0.0.0:3000/contents/${entityContent[1].hash}`
            }
          }
        })
      })
    })

    describe('and it has skybox with fixedTime configured', () => {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
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
              skyboxConfig: {
                fixedTime: 36000
              }
            }
          }
        })
      })

      it('should respond with 200 and skybox fixedHour configuration', async () => {
        const { localFetch } = components

        const r = await localFetch.fetch(`/world/${worldName}/about`)

        expect(r.status).toEqual(200)
        expect(await r.json()).toMatchObject({
          configurations: {
            skybox: {
              fixedHour: 36000,
              textures: []
            }
          }
        })
      })
    })

    describe('and it has skybox textures configured', () => {
      let worldName: string
      let entityContent: { file: string; hash: string }[]

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
        const files = new Map<string, Uint8Array>()
        files.set('abc.png', Buffer.from(stringToUtf8Bytes('Hello world')))

        const result = await worldCreator.createWorldWithScene({
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

        entityContent = result.entity.content
      })

      it('should respond with 200 and skybox textures URLs', async () => {
        const { localFetch } = components

        const r = await localFetch.fetch(`/world/${worldName}/about`)

        expect(r.status).toEqual(200)
        expect(await r.json()).toMatchObject({
          configurations: {
            skybox: {
              textures: [`http://0.0.0.0:3000/contents/${entityContent[0].hash}`]
            }
          }
        })
      })
    })

    describe('and it uses offline comms adapter', () => {
      let worldName: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()
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
      })

      it('should respond with 200 and offline comms adapter configuration', async () => {
        const { localFetch } = components

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
    })

    describe('and it has multiple scenes deployed at different parcels', () => {
      let worldName: string
      let lastDeployedEntityId: string

      beforeEach(async () => {
        const { worldCreator } = components

        worldName = worldCreator.randomWorldName()

        // First scene at spawn point (20,24)
        await worldCreator.createWorldWithScene({
          worldName: worldName,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24']
            },
            worldConfiguration: {
              name: worldName
            }
          }
        })

        // Second scene at different parcels (30,34) - this is the last deployed scene
        const secondResult = await worldCreator.createWorldWithScene({
          worldName: worldName,
          metadata: {
            main: 'def.txt',
            scene: {
              base: '30,34',
              parcels: ['30,34']
            },
            worldConfiguration: {
              name: worldName
            }
          }
        })
        lastDeployedEntityId = secondResult.entityId
      })

      it('should respond with 200 and only the last deployed scene in scenesUrn', async () => {
        const { localFetch } = components

        const r = await localFetch.fetch(`/world/${worldName}/about`)

        expect(r.status).toEqual(200)
        const body = await r.json()
        expect(body.configurations.scenesUrn).toHaveLength(1)
        expect(body.configurations.scenesUrn).toContain(
          `urn:decentraland:entity:${lastDeployedEntityId}?=&baseUrl=http://0.0.0.0:3000/contents/`
        )
        // Spawn coordinates remain at the original location
        expect(body.spawnCoordinates).toEqual('20,24')
      })
    })
  })

  describe('when the world name is deny-listed', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components
      const { nameDenyListChecker } = stubComponents

      const result = await worldCreator.createWorldWithScene()
      worldName = result.worldName

      nameDenyListChecker.checkNameDenyList.withArgs(worldName).resolves(false)
    })

    it('should respond with 404 status and an error message indicating no scene is deployed', async () => {
      const { localFetch } = components

      const r = await localFetch.fetch(`/world/${worldName}/about`)

      expect(r.status).toEqual(404)
      expect(await r.json()).toMatchObject({ message: `World "${worldName}" has no scene deployed.` })
    })
  })

  describe('when the wallet owner is blocked', () => {
    let worldName: string

    beforeEach(async () => {
      const { database, worldCreator } = components
      const { nameDenyListChecker } = stubComponents

      const identity = await getIdentity()
      const result = await worldCreator.createWorldWithScene({
        owner: identity.authChain
      })
      worldName = result.worldName

      const blockedSince = new Date()
      blockedSince.setDate(blockedSince.getDate() - 3)
      await database.query(SQL`
        INSERT INTO blocked (wallet, created_at, updated_at)
            VALUES (${identity.realAccount.address.toLowerCase()}, ${blockedSince}, ${new Date()})
        `)

      nameDenyListChecker.checkNameDenyList.withArgs(worldName).resolves(true)
    })

    it('should respond with 401 status and Not Authorized error', async () => {
      const { localFetch } = components

      const r = await localFetch.fetch(`/world/${worldName}/about`)

      expect(r.status).toEqual(401)
      expect(await r.json()).toMatchObject({
        error: 'Not Authorized',
        message: expect.any(String)
      })
    })
  })
})
