import { test } from '../components'

test('GET /deployments handler', function ({ components }) {
  it('should filter deployments by name', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene({ worldName: 'world1.dcl.eth' })
    await worldCreator.createWorldWithScene({ worldName: 'world2.dcl.eth' })

    const r = await localFetch.fetch('/deployments?name=world1.dcl.eth')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments).toHaveLength(1)
    expect(response.deployments[0].entityId).toEqual(world1.entityId)
    expect(response.filters).toMatchObject({
      name: ['world1.dcl.eth']
    })
  })

  it('should filter deployments by multiple names', async () => {
    const { localFetch, worldCreator } = components

    await worldCreator.createWorldWithScene({ worldName: 'world1.dcl.eth' })
    await worldCreator.createWorldWithScene({ worldName: 'world2.dcl.eth' })
    await worldCreator.createWorldWithScene({ worldName: 'world3.dcl.eth' })

    const r = await localFetch.fetch('/deployments?name=world1.dcl.eth,world2.dcl.eth')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments).toHaveLength(2)
    expect(response.filters).toMatchObject({
      name: ['world1.dcl.eth', 'world2.dcl.eth']
    })
  })

  it('should filter deployments by entityId', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene()
    await worldCreator.createWorldWithScene()

    const r = await localFetch.fetch(`/deployments?entityId=${world1.entityId}`)
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments).toHaveLength(1)
    expect(response.deployments[0].entityId).toEqual(world1.entityId)
    expect(response.filters).toMatchObject({
      entityIds: [world1.entityId.toLowerCase()]
    })
  })

  it('should filter deployments by owner', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene()
    const ownerAddress = world1.owner.authChain[0].payload

    const r = await localFetch.fetch(`/deployments?owner=${ownerAddress}`)
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments.length).toBeGreaterThan(0)
    expect(response.filters).toMatchObject({
      owner: [ownerAddress.toLowerCase()]
    })
  })

  it('should filter deployments by deployer', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene()
    const deployerAddress = world1.owner.authChain[0].payload

    const r = await localFetch.fetch(`/deployments?deployer=${deployerAddress}`)
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments.length).toBeGreaterThan(0)
    expect(response.filters).toMatchObject({
      deployer: [deployerAddress.toLowerCase()]
    })
  })

  it('should support pagination with limit', async () => {
    const { localFetch, worldCreator } = components

    await worldCreator.createWorldWithScene()
    await worldCreator.createWorldWithScene()
    await worldCreator.createWorldWithScene()

    const r = await localFetch.fetch('/deployments?limit=2')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments).toHaveLength(2)
    expect(response.pagination).toMatchObject({
      offset: 0,
      limit: 2,
      moreData: true
    })
  })

  it('should support pagination with offset', async () => {
    const { localFetch, worldCreator } = components

    await worldCreator.createWorldWithScene()
    await worldCreator.createWorldWithScene()
    await worldCreator.createWorldWithScene()

    const r = await localFetch.fetch('/deployments?limit=10&offset=1')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments).toHaveLength(2)
    expect(response.pagination).toMatchObject({
      offset: 1,
      limit: 10,
      moreData: false
    })
  })

  it('should use default limit of 100 when not specified', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.pagination.limit).toEqual(100)
  })

  it('should cap limit at 500 maximum', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments?limit=1000')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.pagination.limit).toEqual(500)
  })

  it('should handle invalid limit by using default', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments?limit=invalid')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.pagination.limit).toEqual(100)
  })

  it('should handle negative limit by setting it to 0', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments?limit=-10')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.pagination.limit).toEqual(0)
  })

  it('should handle invalid offset by using default', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments?offset=invalid')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.pagination.offset).toEqual(0)
  })

  it('should handle negative offset by setting it to 0', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments?offset=-5')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.pagination.offset).toEqual(0)
  })

  it('should combine multiple filters', async () => {
    const { localFetch, worldCreator } = components

    const world1 = await worldCreator.createWorldWithScene({ worldName: 'test.dcl.eth' })
    const ownerAddress = world1.owner.authChain[0].payload

    const r = await localFetch.fetch(`/deployments?name=test.dcl.eth&owner=${ownerAddress}&limit=5`)
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments).toHaveLength(1)
    expect(response.filters).toMatchObject({
      name: ['test.dcl.eth'],
      owner: [ownerAddress.toLowerCase()]
    })
    expect(response.pagination.limit).toEqual(5)
  })

  it('should handle empty filter values', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments?name=')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.filters.name).toBeUndefined()
  })

  it('should trim and lowercase filter values', async () => {
    const { localFetch, worldCreator } = components

    await worldCreator.createWorldWithScene({ worldName: 'test.dcl.eth' })

    const r = await localFetch.fetch('/deployments?name= TEST.DCL.ETH ')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.filters).toMatchObject({
      name: ['test.dcl.eth']
    })
    expect(response.deployments).toHaveLength(1)
  })

  it('should handle comma-separated values with spaces', async () => {
    const { localFetch, worldCreator } = components

    await worldCreator.createWorldWithScene({ worldName: 'world1.dcl.eth' })
    await worldCreator.createWorldWithScene({ worldName: 'world2.dcl.eth' })

    const r = await localFetch.fetch('/deployments?name= world1.dcl.eth , world2.dcl.eth ')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.filters).toMatchObject({
      name: ['world1.dcl.eth', 'world2.dcl.eth']
    })
    expect(response.deployments).toHaveLength(2)
  })

  it('should return empty array when no deployments match filters', async () => {
    const { localFetch, worldCreator } = components

    await worldCreator.createWorldWithScene({ worldName: 'test.dcl.eth' })

    const r = await localFetch.fetch('/deployments?name=nonexistent.dcl.eth')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.deployments).toEqual([])
    expect(response.filters).toMatchObject({
      name: ['nonexistent.dcl.eth']
    })
  })

  it('should handle decimal limit values by flooring them', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments?limit=10.7')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.pagination.limit).toEqual(10)
  })

  it('should handle decimal offset values by flooring them', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/deployments?offset=5.9')
    expect(r.status).toEqual(200)

    const response = await r.json()
    expect(response.pagination.offset).toEqual(5)
  })
})
