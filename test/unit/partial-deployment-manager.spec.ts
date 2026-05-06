import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { createPartialDeploymentStore } from '../../src/adapters/partial-deployment-store'
import { createPartialDeploymentTempStorage } from '../../src/adapters/partial-deployment-temp-storage'
import { createMutex } from '../../src/adapters/partial-deployment-mutex'
import { createPartialDeploymentManager } from '../../src/adapters/partial-deployment-manager'
import { IPartialDeploymentValidator } from '../../src/types'
import { bufferToStream } from '@dcl/catalyst-storage'

const okValidator: IPartialDeploymentValidator = {
  preflight: async () => ({ ok: () => true, errors: [] }),
  final: async () => ({ ok: () => true, errors: [] })
}

const baseLogger: any = {
  log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}
}

function makeManager(opts: { validator?: IPartialDeploymentValidator } = {}) {
  const storage = createInMemoryStorage()
  const store = createPartialDeploymentStore()
  const tempStorage = createPartialDeploymentTempStorage({ storage })
  const mutex = createMutex()
  const manager = createPartialDeploymentManager({
    storage,
    partialDeploymentStore: store,
    partialDeploymentTempStorage: tempStorage,
    partialDeploymentValidator: opts.validator ?? okValidator,
    entityDeployer: { deployEntity: jest.fn().mockResolvedValue({ message: 'ok' }) } as any,
    logs: { getLogger: () => baseLogger } as any
  } as any, mutex)
  return { manager, store, storage, tempStorage }
}

describe('partialDeploymentManager.init', () => {
  it('returns a deployment token, expiresAt, and missingFiles', async () => {
    const { manager } = makeManager()
    const result = await manager.init({
      entityId: 'QmEntity',
      entityRaw: Buffer.from('{"content":[]}'),
      authChain: [{ type: 'SIGNER' as any, payload: '0xabc', signature: '' }],
      ownerAddress: '0xabc',
      manifest: { QmA: 10, QmB: 20 }
    })

    expect(result.deploymentToken).toMatch(/^[a-f0-9]{64}$/)
    expect(result.expiresAt).toBeGreaterThan(Date.now())
    expect(result.missingFiles.sort()).toEqual(['QmA', 'QmB'])
    expect(result.availableFiles).toEqual([])
  })

  it('marks already-stored hashes as available', async () => {
    const { manager, storage } = makeManager()
    await storage.storeStream('QmA', bufferToStream(Buffer.from('a')))
    const result = await manager.init({
      entityId: 'QmEntity',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { QmA: 1, QmB: 2 }
    })
    expect(result.availableFiles).toEqual(['QmA'])
    expect(result.missingFiles).toEqual(['QmB'])
  })

  it('idempotent re-init for the same wallet returns the same token', async () => {
    const { manager } = makeManager()
    const r1 = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { QmA: 1 }
    })
    const r2 = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { QmA: 1 }
    })
    expect(r2.deploymentToken).toBe(r1.deploymentToken)
  })

  it('rejects re-init from a different wallet', async () => {
    const { manager } = makeManager()
    await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xaaa',
      manifest: { QmA: 1 }
    })
    await expect(
      manager.init({
        entityId: 'QmE',
        entityRaw: Buffer.from('{}'),
        authChain: [],
        ownerAddress: '0xbbb',
        manifest: { QmA: 1 }
      })
    ).rejects.toThrow(/owner mismatch/i)
  })

  it('throws if validator.preflight rejects', async () => {
    const validator = {
      preflight: async () => ({ ok: () => false, errors: ['nope'] }),
      final: async () => ({ ok: () => true, errors: [] })
    }
    const { manager } = makeManager({ validator })
    await expect(
      manager.init({
        entityId: 'QmE',
        entityRaw: Buffer.from('{}'),
        authChain: [],
        ownerAddress: '0xabc',
        manifest: {}
      })
    ).rejects.toThrow(/nope/)
  })
})
