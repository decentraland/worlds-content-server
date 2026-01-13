import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'
import { Entity, IPFSv2 } from '@dcl/schemas'
import { makeid } from '../utils'

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
})
