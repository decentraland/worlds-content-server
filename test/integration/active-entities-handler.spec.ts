import { test } from '../components'

test('active entities handler /entities/active', function ({ components }) {
  it('when world is not yet deployed it responds [] in active entities', async () => {
    const { localFetch, worldCreator } = components
    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify({ pointers: [worldCreator.randomWorldName()] }),
      headers: {
        'Content-Type': 'application/json'
      }
    })
    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual([])
  })

  it('when wrong input responds with error 400', async () => {
    const { localFetch } = components
    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify([]),
      headers: {
        'Content-Type': 'application/json'
      }
    })
    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({ message: 'Invalid request. Request body is not valid' })
  })

  it('when world is deployed it responds with the entity in active entities endpoint', async () => {
    const { localFetch, worldCreator } = components

    const { worldName, entity, entityId } = await worldCreator.createWorldWithScene()

    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify({ pointers: [worldName] }),
      headers: {
        'Content-Type': 'application/json'
      }
    })

    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject([
      {
        ...entity,
        id: entityId
      }
    ])
  })
})
