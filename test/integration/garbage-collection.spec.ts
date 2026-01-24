import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'
import { Entity, IPFSv2 } from '@dcl/schemas'
import { makeid } from '../utils'
import { bufferToStream } from '@dcl/catalyst-storage'
import { createHash } from 'crypto'

test('when performing garbage collection through /gc', function ({ components }) {
  afterEach(async () => {
    jest.resetAllMocks()

    // Clear storage to ensure test isolation
    const { storage } = components
    const fileIds: string[] = []
    for await (const fileId of storage.allFileIds()) {
      fileIds.push(fileId)
    }
    if (fileIds.length > 0) {
      await storage.delete(fileIds)
    }
  })

  describe('and there are unused files from a previous deployment', () => {
    let oldEntityId: IPFSv2
    let oldEntity: Entity
    let newEntityId: IPFSv2
    let newEntity: Entity

    beforeEach(async () => {
      const { worldCreator } = components

      const worldName = worldCreator.randomWorldName()

      const files = new Map<string, Uint8Array>()
      files.set('abc.png', stringToUtf8Bytes(makeid(150)))
      files.set('abc.txt', stringToUtf8Bytes(makeid(50)))

      const firstDeployment = await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24']
          },
          worldConfiguration: {
            name: worldName
          }
        },
        files
      })

      oldEntityId = firstDeployment.entityId
      oldEntity = firstDeployment.entity

      const newFiles = new Map<string, Uint8Array>()
      newFiles.set('abc.png', stringToUtf8Bytes(makeid(150)))
      newFiles.set('abc.txt', stringToUtf8Bytes(makeid(50)))

      const secondDeployment = await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24']
          },
          worldConfiguration: {
            name: worldName
          }
        },
        files: newFiles
      })

      newEntityId = secondDeployment.entityId
      newEntity = secondDeployment.entity
    })

    it('should have both old and new entity files in storage before garbage collection', async () => {
      const { storage } = components

      // Old entity files
      expect(await storage.exist(oldEntityId)).toBeTruthy()
      expect(await storage.exist(`${oldEntityId}.auth`)).toBeTruthy()
      expect(await storage.exist(oldEntity.content![0].hash)).toBeTruthy()
      expect(await storage.exist(oldEntity.content![1].hash)).toBeTruthy()

      // New entity files
      expect(await storage.exist(newEntityId)).toBeTruthy()
      expect(await storage.exist(`${newEntityId}.auth`)).toBeTruthy()
      expect(await storage.exist(newEntity.content![0].hash)).toBeTruthy()
      expect(await storage.exist(newEntity.content![1].hash)).toBeTruthy()
    })

    describe('and garbage collection is triggered', () => {
      it('should respond with 200 and remove exactly 4 unused keys', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch('/gc', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here'
          }
        })

        expect(response.status).toEqual(200)
        expect(await response.json()).toMatchObject({
          message: 'Garbage collection removed 4 unused keys.'
        })
      })

      it('should remove the old entity files from storage', async () => {
        const { localFetch, storage } = components

        await localFetch.fetch('/gc', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here'
          }
        })

        expect(await storage.exist(oldEntityId)).toBeFalsy()
        expect(await storage.exist(`${oldEntityId}.auth`)).toBeFalsy()
        expect(await storage.exist(oldEntity.content![0].hash)).toBeFalsy()
        expect(await storage.exist(oldEntity.content![1].hash)).toBeFalsy()
      })

      it('should keep the active entity files in storage', async () => {
        const { localFetch, storage } = components

        await localFetch.fetch('/gc', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here'
          }
        })

        expect(await storage.exist(newEntityId)).toBeTruthy()
        expect(await storage.exist(`${newEntityId}.auth`)).toBeTruthy()
        expect(await storage.exist(newEntity.content![0].hash)).toBeTruthy()
        expect(await storage.exist(newEntity.content![1].hash)).toBeTruthy()
      })
    })
  })

  describe('and there are no unused files in storage', () => {
    beforeEach(async () => {
      const { worldCreator } = components

      const worldName = worldCreator.randomWorldName()
      const files = new Map<string, Uint8Array>()
      files.set('abc.txt', stringToUtf8Bytes(makeid(50)))

      await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24']
          },
          worldConfiguration: {
            name: worldName
          }
        },
        files
      })
    })

    it('should respond with 200 and report no removed keys', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch('/gc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer setup_some_secret_here'
        }
      })

      expect(response.status).toEqual(200)
      expect(await response.json()).toMatchObject({
        message: 'Garbage collection removed 0 unused keys.'
      })
    })
  })

  describe('and there are thumbnail files in storage', () => {
    describe('when the thumbnail is referenced by a world', () => {
      let thumbnailHash: string

      beforeEach(async () => {
        const { worldCreator, worldsManager, storage } = components

        const worldName = worldCreator.randomWorldName()
        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(50)))

        const created = await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24']
            },
            worldConfiguration: {
              name: worldName
            }
          },
          files
        })

        // Store a thumbnail and update world settings to reference it
        const thumbnailContent = Buffer.from('fake-thumbnail-content')
        thumbnailHash = createHash('sha256').update(thumbnailContent).digest('hex')
        await storage.storeStream(thumbnailHash, bufferToStream(thumbnailContent))

        const owner = created.owner.authChain[0].payload
        await worldsManager.updateWorldSettings(worldName, owner, { thumbnailHash })
      })

      it('should keep the thumbnail in storage', async () => {
        const { localFetch, storage } = components

        await localFetch.fetch('/gc', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here'
          }
        })

        expect(await storage.exist(thumbnailHash)).toBeTruthy()
      })
    })

    describe('when the thumbnail is no longer referenced by any world', () => {
      let oldThumbnailHash: string
      let newThumbnailHash: string

      beforeEach(async () => {
        const { worldCreator, worldsManager, storage } = components

        const worldName = worldCreator.randomWorldName()
        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(50)))

        const created = await worldCreator.createWorldWithScene({
          worldName,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24']
            },
            worldConfiguration: {
              name: worldName
            }
          },
          files
        })

        const owner = created.owner.authChain[0].payload

        // Store first thumbnail and set it
        const oldThumbnailContent = Buffer.from('old-thumbnail-content')
        oldThumbnailHash = createHash('sha256').update(oldThumbnailContent).digest('hex')
        await storage.storeStream(oldThumbnailHash, bufferToStream(oldThumbnailContent))
        await worldsManager.updateWorldSettings(worldName, owner, { thumbnailHash: oldThumbnailHash })

        // Store new thumbnail and update world to use it (orphaning the old one)
        const newThumbnailContent = Buffer.from('new-thumbnail-content')
        newThumbnailHash = createHash('sha256').update(newThumbnailContent).digest('hex')
        await storage.storeStream(newThumbnailHash, bufferToStream(newThumbnailContent))
        await worldsManager.updateWorldSettings(worldName, owner, { thumbnailHash: newThumbnailHash })
      })

      it('should remove the orphaned thumbnail from storage', async () => {
        const { localFetch, storage } = components

        await localFetch.fetch('/gc', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here'
          }
        })

        expect(await storage.exist(oldThumbnailHash)).toBeFalsy()
      })

      it('should keep the active thumbnail in storage', async () => {
        const { localFetch, storage } = components

        await localFetch.fetch('/gc', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here'
          }
        })

        expect(await storage.exist(newThumbnailHash)).toBeTruthy()
      })
    })

    describe('when multiple worlds share the same thumbnail', () => {
      let sharedThumbnailHash: string

      beforeEach(async () => {
        const { worldCreator, worldsManager, storage } = components

        // Create shared thumbnail
        const thumbnailContent = Buffer.from('shared-thumbnail-content')
        sharedThumbnailHash = createHash('sha256').update(thumbnailContent).digest('hex')
        await storage.storeStream(sharedThumbnailHash, bufferToStream(thumbnailContent))

        // Create first world with the shared thumbnail
        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(50)))

        const firstWorld = await worldCreator.createWorldWithScene({
          worldName: worldCreator.randomWorldName(),
          metadata: {
            main: 'abc.txt',
            scene: { base: '20,24', parcels: ['20,24'] },
            worldConfiguration: { name: 'first-world' }
          },
          files
        })
        await worldsManager.updateWorldSettings(firstWorld.worldName, firstWorld.owner.authChain[0].payload, {
          thumbnailHash: sharedThumbnailHash
        })

        // Create second world with the same thumbnail
        const secondWorld = await worldCreator.createWorldWithScene({
          worldName: worldCreator.randomWorldName(),
          metadata: {
            main: 'abc.txt',
            scene: { base: '20,24', parcels: ['20,24'] },
            worldConfiguration: { name: 'second-world' }
          },
          files: new Map([['abc.txt', stringToUtf8Bytes(makeid(50))]])
        })
        await worldsManager.updateWorldSettings(secondWorld.worldName, secondWorld.owner.authChain[0].payload, {
          thumbnailHash: sharedThumbnailHash
        })
      })

      it('should keep the shared thumbnail in storage', async () => {
        const { localFetch, storage } = components

        await localFetch.fetch('/gc', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here'
          }
        })

        expect(await storage.exist(sharedThumbnailHash)).toBeTruthy()
      })
    })
  })
})
