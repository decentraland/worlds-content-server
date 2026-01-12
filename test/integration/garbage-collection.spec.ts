import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'
import { Entity, IPFSv2 } from '@dcl/schemas'
import { makeid } from '../utils'

test('when performing garbage collection through /gc', function ({ components }) {
  describe('and there are unused files from a previous deployment', () => {
    let worldName: string
    let oldEntityId: IPFSv2
    let oldEntity: Entity
    let newEntityId: IPFSv2
    let newEntity: Entity

    beforeEach(async () => {
      const { worldCreator } = components
      worldName = worldCreator.randomWorldName()

      // deploy an initial version of the scene
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

      // deploy a new version of the scene
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

    it('should respond with 200 and the count of removed keys', async () => {
      const { localFetch, storage } = components

      // verify old files exist
      expect(await storage.exist(oldEntityId)).toBeTruthy()
      expect(await storage.exist(`${oldEntityId}.auth`)).toBeTruthy()
      expect(await storage.exist(oldEntity.content![0].hash)).toBeTruthy()
      expect(await storage.exist(oldEntity.content![1].hash)).toBeTruthy()

      // verify new files exist
      expect(await storage.exist(newEntityId)).toBeTruthy()
      expect(await storage.exist(`${newEntityId}.auth`)).toBeTruthy()
      expect(await storage.exist(newEntity.content![0].hash)).toBeTruthy()
      expect(await storage.exist(newEntity.content![1].hash)).toBeTruthy()

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

    it('should remove the old entity and auth files from storage', async () => {
      const { localFetch, storage } = components

      await localFetch.fetch('/gc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer setup_some_secret_here'
        }
      })

      expect(await storage.exist(oldEntityId)).toBeFalsy()
      expect(await storage.exist(`${oldEntityId}.auth`)).toBeFalsy()
    })

    it('should remove the old content files from storage', async () => {
      const { localFetch, storage } = components

      await localFetch.fetch('/gc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer setup_some_secret_here'
        }
      })

      expect(await storage.exist(oldEntity.content![0].hash)).toBeFalsy()
      expect(await storage.exist(oldEntity.content![1].hash)).toBeFalsy()
    })

    it('should keep the active entity and auth files in storage', async () => {
      const { localFetch, storage } = components

      await localFetch.fetch('/gc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer setup_some_secret_here'
        }
      })

      expect(await storage.exist(newEntityId)).toBeTruthy()
      expect(await storage.exist(`${newEntityId}.auth`)).toBeTruthy()
    })

    it('should keep the active content files in storage', async () => {
      const { localFetch, storage } = components

      await localFetch.fetch('/gc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer setup_some_secret_here'
        }
      })

      expect(await storage.exist(newEntity.content![0].hash)).toBeTruthy()
      expect(await storage.exist(newEntity.content![1].hash)).toBeTruthy()
    })
  })

  describe('and there are no unused files in storage', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components

      worldName = worldCreator.randomWorldName()

      // deploy only one version of the scene
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
