import { createPartialDeploymentStore } from '../../src/adapters/partial-deployment-store'
import { createPartialDeploymentSweeper } from '../../src/adapters/partial-deployment-sweeper'

const baseLogger: any = {
  log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}
}

describe('partialDeploymentSweeper', () => {
  it('removes expired records on tick', async () => {
    const store = createPartialDeploymentStore()
    await store.put({
      entityId: 'old',
      authChain: [], ownerAddress: '0x', manifest: {},
      uploadedHashes: new Set(), alreadyAvailableHashes: new Set(),
      deploymentToken: 't', expiresAt: Date.now() - 10_000
    })
    await store.put({
      entityId: 'new',
      authChain: [], ownerAddress: '0x', manifest: {},
      uploadedHashes: new Set(), alreadyAvailableHashes: new Set(),
      deploymentToken: 't', expiresAt: Date.now() + 60_000
    })

    const onCleanup = jest.fn().mockResolvedValue(undefined)
    const sweeper = createPartialDeploymentSweeper(
      { partialDeploymentStore: store, logs: { getLogger: () => baseLogger } as any },
      { intervalMs: 1_000_000, onCleanupExpiredEntity: onCleanup }
    )

    await sweeper.runOnce()

    expect(onCleanup).toHaveBeenCalledTimes(1)
    expect(onCleanup).toHaveBeenCalledWith('old')
    expect(await store.get('old')).toBeUndefined()
    expect(await store.get('new')).toBeDefined()
  })

  it('survives a failure in onCleanupExpiredEntity (continues with the next id)', async () => {
    const store = createPartialDeploymentStore()
    for (const id of ['a', 'b', 'c']) {
      await store.put({
        entityId: id,
        authChain: [], ownerAddress: '0x', manifest: {},
        uploadedHashes: new Set(), alreadyAvailableHashes: new Set(),
        deploymentToken: 't', expiresAt: Date.now() - 1
      })
    }
    const onCleanup = jest.fn().mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('boom')
    })
    const sweeper = createPartialDeploymentSweeper(
      { partialDeploymentStore: store, logs: { getLogger: () => baseLogger } as any },
      { intervalMs: 1_000_000, onCleanupExpiredEntity: onCleanup }
    )

    await sweeper.runOnce()
    expect(onCleanup).toHaveBeenCalledTimes(3)
    expect(await store.get('a')).toBeUndefined()
    expect(await store.get('b')).toBeUndefined()
    expect(await store.get('c')).toBeUndefined()
  })
})
