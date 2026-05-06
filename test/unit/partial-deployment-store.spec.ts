import { createPartialDeploymentStore } from '../../src/adapters/partial-deployment-store'
import { DeploymentRecord } from '../../src/types'

function makeRecord(entityId: string, expiresAt: number): DeploymentRecord {
  return {
    entityId,
    authChain: [],
    ownerAddress: '0xabc',
    manifest: { QmA: 3 },
    uploadedHashes: new Set(),
    alreadyAvailableHashes: new Set(),
    deploymentToken: 'tok-' + entityId,
    expiresAt
  }
}

describe('createPartialDeploymentStore', () => {
  it('put/get round-trips the record', async () => {
    const store = createPartialDeploymentStore()
    const r = makeRecord('QmEntity', Date.now() + 60_000)
    await store.put(r)
    const got = await store.get('QmEntity')
    expect(got).toBe(r) // same reference (in-memory)
  })

  it('returns undefined for unknown id', async () => {
    const store = createPartialDeploymentStore()
    expect(await store.get('QmNope')).toBeUndefined()
  })

  it('markUploaded mutates the record uploadedHashes set', async () => {
    const store = createPartialDeploymentStore()
    const r = makeRecord('QmE', Date.now() + 60_000)
    await store.put(r)
    await store.markUploaded('QmE', 'QmA')
    expect((await store.get('QmE'))!.uploadedHashes.has('QmA')).toBe(true)
  })

  it('markUploaded throws if the deployment is unknown', async () => {
    const store = createPartialDeploymentStore()
    await expect(store.markUploaded('QmNope', 'QmA')).rejects.toThrow(/not found/i)
  })

  it('delete removes the record', async () => {
    const store = createPartialDeploymentStore()
    await store.put(makeRecord('QmE', Date.now() + 60_000))
    await store.delete('QmE')
    expect(await store.get('QmE')).toBeUndefined()
  })

  it('listExpiredBefore returns entityIds older than the cutoff', async () => {
    const store = createPartialDeploymentStore()
    await store.put(makeRecord('Old', 100))
    await store.put(makeRecord('New', 500))
    expect((await store.listExpiredBefore(200)).sort()).toEqual(['Old'])
    expect((await store.listExpiredBefore(1000)).sort()).toEqual(['New', 'Old'])
  })

  it('clear empties the store', async () => {
    const store = createPartialDeploymentStore()
    await store.put(makeRecord('A', 1))
    await store.put(makeRecord('B', 1))
    await store.clear()
    expect(await store.get('A')).toBeUndefined()
    expect(await store.get('B')).toBeUndefined()
  })
})
