import { test } from '../components'
import { ContentClient, createContentClient, DeploymentBuilder } from 'dcl-catalyst-client'
import { EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { stringToUtf8Bytes } from 'eth-connect'
import { hashV1 } from '@dcl/hashing'
import { getIdentity, Identity, makeid, cleanup } from '../utils'
import { defaultAccess } from '../../src/logic/access'

test('DeployEntity POST /entities - parcel-scoped deployment permission boundary', function ({
  components,
  stubComponents
}) {
  afterEach(async () => {
    jest.resetAllMocks()

    const { storage, database } = components
    await cleanup(storage, database)
  })

  describe('when a user is granted deployment permission limited to a single parcel', () => {
    let contentClient: ContentClient
    let owner: Identity
    let grantee: Identity
    let worldName: string
    const grantedParcel = '0,0'

    beforeEach(async () => {
      const { config, fetch, worldCreator, worldsManager } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents
      const permissions = components.permissions

      owner = await getIdentity()
      grantee = await getIdentity()
      worldName = worldCreator.randomWorldName()

      // Create the world owned by `owner` without deploying a scene yet
      await worldsManager.storeAccess(worldName, defaultAccess())

      // Grant `grantee` deployment permission over a SINGLE parcel only
      await permissions.addParcelsToPermission(worldName, 'deployment', grantee.realAccount.address, [grantedParcel])

      contentClient = createContentClient({
        url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
        fetcher: fetch
      })

      // The grantee does NOT own the world name, so the only thing that should
      // authorize a deployment is the parcel-scoped permission.
      // The grantee was given parcel-scoped permission only; name-level permission must resolve false.
      namePermissionChecker.checkPermission.mockResolvedValue(false)
      nameOwnership.findOwners.mockImplementation(async (worldNames) =>
        worldNames.length === 1 && worldNames[0] === worldName
          ? new Map([[worldName, owner.authChain.authChain[0].payload]])
          : new Map()
      )
      snsClient.publishMessage.mockResolvedValue({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })
    })

    describe('and they deploy a scene confined to the granted parcel', () => {
      let entityId: string
      let files: Map<string, Uint8Array>

      beforeEach(async () => {
        const entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const result = await DeploymentBuilder.buildEntity({
          type: EntityType.SCENE as any,
          pointers: [grantedParcel],
          files: entityFiles,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: grantedParcel,
              parcels: [grantedParcel]
            },
            worldConfiguration: {
              name: worldName
            }
          }
        })

        entityId = result.entityId
        files = result.files
      })

      it('should deploy successfully', async () => {
        const authChain = Authenticator.signPayload(grantee.authChain, entityId)

        const response = (await contentClient.deploy({ files, entityId, authChain })) as Response
        const responseBody = await response.json()

        expect(responseBody).toMatchObject({
          message: expect.stringContaining(worldName)
        })
      })
    })

    describe('and they deploy a scene to parcels outside their granted permission', () => {
      let entityId: string
      let fileHash: string
      let files: Map<string, Uint8Array>
      const unauthorizedParcel = '100,100'

      beforeEach(async () => {
        const entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))
        fileHash = await hashV1(entityFiles.get('abc.txt')!)

        const result = await DeploymentBuilder.buildEntity({
          type: EntityType.SCENE as any,
          pointers: [unauthorizedParcel],
          files: entityFiles,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: unauthorizedParcel,
              parcels: [unauthorizedParcel]
            },
            worldConfiguration: {
              name: worldName
            }
          }
        })

        entityId = result.entityId
        files = result.files
      })

      it('should reject the deployment with a permission error', async () => {
        const authChain = Authenticator.signPayload(grantee.authChain, entityId)

        await expect(() => contentClient.deploy({ files, entityId, authChain })).rejects.toThrow(
          `Your wallet has no permission to publish this scene because it does not have permission to deploy under \\"${worldName}\\". Check scene.json to select a name that either you own or you were given permission to deploy.`
        )
      })

      it('should not store the entity in storage', async () => {
        const { storage } = components
        const authChain = Authenticator.signPayload(grantee.authChain, entityId)

        try {
          await contentClient.deploy({ files, entityId, authChain })
        } catch {
          // Expected to fail
        }

        expect(await storage.exist(fileHash)).toBe(false)
        expect(await storage.exist(entityId)).toBe(false)
      })

      it('should not place any scene at the unauthorized parcels', async () => {
        const { worldsManager } = components
        const authChain = Authenticator.signPayload(grantee.authChain, entityId)

        try {
          await contentClient.deploy({ files, entityId, authChain })
        } catch {
          // Expected to fail
        }

        const { scenes } = await worldsManager.getWorldScenes({ worldName })
        expect(scenes.some((scene) => scene.parcels.includes(unauthorizedParcel))).toBe(false)
      })
    })

    describe('and they deploy a scene whose pointers and scene.parcels reference different parcels', () => {
      let entityId: string
      let fileHash: string
      let files: Map<string, Uint8Array>
      const unauthorizedParcel = '100,100'

      beforeEach(async () => {
        const entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))
        fileHash = await hashV1(entityFiles.get('abc.txt')!)

        const result = await DeploymentBuilder.buildEntity({
          type: EntityType.SCENE as any,
          // The original bypass: keep pointers inside the granted parcel while pointing
          // scene.parcels (which drives placement) elsewhere. This must be rejected for
          // not matching, before the permission check is even reached.
          pointers: [grantedParcel],
          files: entityFiles,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: unauthorizedParcel,
              parcels: [unauthorizedParcel]
            },
            worldConfiguration: {
              name: worldName
            }
          }
        })

        entityId = result.entityId
        files = result.files
      })

      it('should reject the deployment because the pointers do not match the scene parcels', async () => {
        const authChain = Authenticator.signPayload(grantee.authChain, entityId)

        await expect(() => contentClient.deploy({ files, entityId, authChain })).rejects.toThrow(
          `The scene pointers [${grantedParcel}] must match the scene parcels [${unauthorizedParcel}].`
        )
      })

      it('should not store the entity in storage', async () => {
        const { storage } = components
        const authChain = Authenticator.signPayload(grantee.authChain, entityId)

        try {
          await contentClient.deploy({ files, entityId, authChain })
        } catch {
          // Expected to fail
        }

        expect(await storage.exist(fileHash)).toBe(false)
        expect(await storage.exist(entityId)).toBe(false)
      })

      it('should not place any scene at the unauthorized parcels', async () => {
        const { worldsManager } = components
        const authChain = Authenticator.signPayload(grantee.authChain, entityId)

        try {
          await contentClient.deploy({ files, entityId, authChain })
        } catch {
          // Expected to fail
        }

        const { scenes } = await worldsManager.getWorldScenes({ worldName })
        expect(scenes.some((scene) => scene.parcels.includes(unauthorizedParcel))).toBe(false)
      })
    })
  })
})
