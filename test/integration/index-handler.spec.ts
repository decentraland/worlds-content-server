import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'
import { cleanup } from '../utils'

test('index handler GET /index', function ({ components }) {
  afterEach(async () => {
    const { storage, database } = components
    await cleanup(storage, database)
  })

  it('returns the index with deployed worlds', async () => {
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
    const body = await r.json()

    expect(body.lastUpdated).toEqual(expect.any(String))
    expect(body.data.length).toBeGreaterThanOrEqual(2)

    // Find the worlds by name
    const world1Data = body.data.find((w: { name: string }) => w.name === w1.worldName)
    const world2Data = body.data.find((w: { name: string }) => w.name === w2.worldName)

    expect(world1Data).toBeDefined()
    expect(world1Data.scenes).toHaveLength(1)
    expect(world1Data.scenes[0]).toMatchObject({
      id: w1.entityId,
      title: w1.entity.metadata.display.title,
      description: w1.entity.metadata.display.description,
      pointers: w1.entity.pointers,
      timestamp: w1.entity.timestamp
    })
    expect(world1Data.scenes[0].thumbnail).toContain(`/contents/${w1.entity.content[0].hash}`)

    expect(world2Data).toBeDefined()
    expect(world2Data.scenes).toHaveLength(1)
    expect(world2Data.scenes[0]).toMatchObject({
      id: w2.entityId,
      title: w2.entity.metadata.display.title,
      description: w2.entity.metadata.display.description,
      pointers: w2.entity.pointers,
      timestamp: w2.entity.timestamp
    })
    expect(world2Data.scenes[0].thumbnail).toBeUndefined()
  })

  it('returns the full index by default and honors explicit limit/offset', async () => {
    const { localFetch, worldCreator } = components

    await worldCreator.createWorldWithScene()
    await worldCreator.createWorldWithScene()

    // No pagination params: returns every world (backward compatible for consumers like the
    // AB-conversion snapshot job that expect the full set).
    const all = (await (await localFetch.fetch('/index')).json()).data
    expect(all.length).toBeGreaterThanOrEqual(2)

    // Explicit limit/offset paginate over the same ordering.
    const firstPage = (await (await localFetch.fetch('/index?limit=1&offset=0')).json()).data
    const secondPage = (await (await localFetch.fetch('/index?limit=1&offset=1')).json()).data
    expect(firstPage).toHaveLength(1)
    expect(secondPage).toHaveLength(1)
    expect(secondPage[0].name).not.toBe(firstPage[0].name)
  })
})
