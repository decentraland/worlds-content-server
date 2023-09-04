import { test } from '../components'
import { Entity } from '@dcl/schemas'
import { cleanup } from '../utils'

test('consume get endpoints', function ({ components }) {
  let entity: Entity

  beforeAll(async () => {
    await cleanup(components.storage, components.pg)
    const { worldCreator } = components
    const created = await worldCreator.createWorldWithScene()
    entity = created.entity
  })

  it('responds /contents/:cid and works', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/contents/bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y')
    expect(r.status).toEqual(404)

    const r2 = await localFetch.fetch(`/contents/${entity.id}`)
    expect(r2.status).toEqual(200)
    expect(await r2.json()).toMatchObject({
      type: 'scene'
    })
  })

  it('responds HEAD /contents/:cid and works', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/contents/bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y', {
      method: 'HEAD'
    })
    expect(r.status).toEqual(404)

    const r2 = await localFetch.fetch(`/contents/${entity.id}`, {
      method: 'HEAD'
    })
    expect(r2.status).toEqual(200)
    expect(await r2.text()).toEqual('')
  })

  it('responds /status works', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/status')

    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject({
      content: {
        commitHash: expect.any(String),
        worldsCount: 1
      },
      comms: {
        rooms: 1,
        users: 2
      }
    })
  })
})
