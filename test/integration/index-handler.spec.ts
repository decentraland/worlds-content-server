import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'

test('index handler GET /index', function ({ components }) {
  it('returns an error when world does not exist', async () => {
    const { localFetch, worldCreator } = components

    const worldName1 = worldCreator.randomWorldName()
    const w1 = await worldCreator.createWorldWithScene({
      worldName: worldName1,
      metadata: {
        main: 'abc.txt',
        display: {
          title: 'My own scene',
          description: 'My own place in the world',
          navmapThumbnail: 'abc.png'
        },
        scene: {
          base: '20,24',
          parcels: ['20,24']
        },
        worldConfiguration: {
          name: worldName1
        }
      },
      files: new Map<string, Uint8Array>([['abc.png', Buffer.from(stringToUtf8Bytes('Hello world'))]])
    })

    const worldName2 = worldCreator.randomWorldName()
    const w2 = await worldCreator.createWorldWithScene({
      worldName: worldName2,
      metadata: {
        main: 'cde.txt',
        display: {
          title: "Someone else's scene",
          description: 'Their own place in the world'
        },
        scene: {
          base: '1,6',
          parcels: ['1,6']
        },
        worldConfiguration: {
          name: worldName2
        }
      }
    })

    const r = await localFetch.fetch('/index')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      data: expect.arrayContaining([
        {
          name: w1.worldName,
          scenes: [
            {
              id: w1.entityId,
              title: w1.entity.metadata.display.title,
              description: w1.entity.metadata.display.description,
              thumbnail: `http://0.0.0.0:3000/contents/${w1.entity.content[0].hash}`,
              pointers: w1.entity.pointers,
              timestamp: w1.entity.timestamp
            }
          ]
        },
        {
          name: w2.worldName,
          scenes: [
            {
              id: w2.entityId,
              title: w2.entity.metadata.display.title,
              description: w2.entity.metadata.display.description,
              pointers: w2.entity.pointers,
              timestamp: w2.entity.timestamp
            }
          ]
        }
      ]),
      lastUpdated: expect.any(String)
    })
  })
})
