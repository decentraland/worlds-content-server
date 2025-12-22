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

  it('when no pointers provided it responds with empty array', async () => {
    const { localFetch } = components
    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify({ pointers: [] }),
      headers: {
        'Content-Type': 'application/json'
      }
    })
    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual([])
  })

  it('when more than 50 pointers it responds with error 400', async () => {
    const { localFetch } = components
    const tooManyPointers = Array.from({ length: 51 }, (_, i) => `world${i}.dcl.eth`)
    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify({ pointers: tooManyPointers }),
      headers: {
        'Content-Type': 'application/json'
      }
    })
    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({ message: 'Maximum 50 pointers allowed per request' })
  })

  it('when multiple worlds are deployed it responds with all entities', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene({ worldName: 'multi1.dcl.eth' })
    const world2 = await worldCreator.createWorldWithScene({ worldName: 'multi2.dcl.eth' })
    const world3 = await worldCreator.createWorldWithScene({ worldName: 'multi3.dcl.eth' })

    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify({ pointers: [world1.worldName, world2.worldName, world3.worldName] }),
      headers: {
        'Content-Type': 'application/json'
      }
    })

    expect(r.status).toEqual(200)
    const response = await r.json()
    expect(response).toHaveLength(3)
    expect(response).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: world1.entityId }),
        expect.objectContaining({ id: world2.entityId }),
        expect.objectContaining({ id: world3.entityId })
      ])
    )
  })

  it('when some pointers not deployed it returns only deployed ones', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene({ worldName: 'deployed-one.dcl.eth' })
    const nonExistentWorld = 'non-existent-world.dcl.eth'

    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify({ pointers: [world1.worldName, nonExistentWorld] }),
      headers: {
        'Content-Type': 'application/json'
      }
    })

    expect(r.status).toEqual(200)
    const response = await r.json()
    expect(response).toHaveLength(1)
    expect(response[0]).toMatchObject({
      id: world1.entityId
    })
  })

  it('when duplicate pointers it deduplicates', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene({ worldName: 'dup-test.dcl.eth' })

    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify({ pointers: [world1.worldName, world1.worldName, world1.worldName] }),
      headers: {
        'Content-Type': 'application/json'
      }
    })

    expect(r.status).toEqual(200)
    const response = await r.json()
    expect(response).toHaveLength(1)
    expect(response[0]).toMatchObject({
      id: world1.entityId
    })
  })

  it('when pointers with different casing it deduplicates case-insensitively', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene({ worldName: 'case-test.dcl.eth' })

    const r = await localFetch.fetch('/entities/active', {
      method: 'POST',
      body: JSON.stringify({ pointers: ['case-test.dcl.eth', 'CASE-TEST.DCL.ETH', 'Case-Test.Dcl.Eth'] }),
      headers: {
        'Content-Type': 'application/json'
      }
    })

    expect(r.status).toEqual(200)
    const response = await r.json()
    expect(response).toHaveLength(1)
    expect(response[0]).toMatchObject({
      id: world1.entityId
    })
  })
})
