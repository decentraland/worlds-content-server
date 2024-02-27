import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'
import { makeid } from '../utils'

test('garbage collection works', function ({ components }) {
  it('cleans up all unused files', async () => {
    const { localFetch, storage, worldCreator } = components

    const worldName = worldCreator.randomWorldName()

    // deploy an initial version of the scene
    const files = new Map<string, Uint8Array>()
    files.set('abc.png', stringToUtf8Bytes(makeid(150)))
    files.set('abc.txt', stringToUtf8Bytes(makeid(50)))

    const { entityId, entity } = await worldCreator.createWorldWithScene({
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

    expect(await storage.exist(entityId)).toBeTruthy()
    expect(await storage.exist(`${entityId}.auth`)).toBeTruthy()
    expect(await storage.exist(entity.content[0].hash)).toBeTruthy()
    expect(await storage.exist(entity.content[1].hash)).toBeTruthy()

    // deploy a new version of the scene
    const newFiles = new Map<string, Uint8Array>()
    newFiles.set('abc.png', stringToUtf8Bytes(makeid(150)))
    newFiles.set('abc.txt', stringToUtf8Bytes(makeid(50)))

    const { entityId: entityId2, entity: entity2 } = await worldCreator.createWorldWithScene({
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

    expect(await storage.exist(entityId2)).toBeTruthy()
    expect(await storage.exist(`${entityId2}.auth`)).toBeTruthy()
    expect(await storage.exist(entity2.content[0].hash)).toBeTruthy()
    expect(await storage.exist(entity2.content[1].hash)).toBeTruthy()

    // run garbage collection
    const response = await localFetch.fetch('/gc', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer setup_some_secret_here'
      }
    })

    // Check old files have been removed
    expect(response.status).toEqual(200)
    expect(await response.json()).toMatchObject({ message: 'Garbage collection removed 4 unused keys.' })
    expect(await storage.exist(entityId)).toBeFalsy()
    expect(await storage.exist(`${entityId}.auth`)).toBeFalsy()
    expect(await storage.exist(entity.content[0].hash)).toBeFalsy()
    expect(await storage.exist(entity.content[1].hash)).toBeFalsy()
  })
})
