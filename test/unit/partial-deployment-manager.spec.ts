import { hashV1 } from '@dcl/hashing'
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

describe('partialDeploymentManager.addFile', () => {
  it('rejects unknown deployment with not-found error', async () => {
    const { manager } = makeManager()
    await expect(
      manager.addFile('QmNope', 'QmA', 'tok', Buffer.from('a'))
    ).rejects.toMatchObject({ message: expect.stringMatching(/not found/i) })
  })

  it('rejects when token mismatches', async () => {
    const bytes = Buffer.from([1, 2, 3])
    const fileHash = await hashV1(bytes)
    const { manager } = makeManager()
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { [fileHash]: 3 }
    })
    expect(init.missingFiles).toContain(fileHash)
    await expect(
      manager.addFile('QmE', fileHash, 'wrong-token', bytes)
    ).rejects.toThrow(/token/i)
  })

  it('rejects when computed hash does not match path hash (FIXES Mariano inverted-check bug)', async () => {
    const bytes = Buffer.from([1, 2, 3])
    const realHash = await hashV1(bytes)
    const { manager } = makeManager()
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { [realHash]: 3 }
    })

    await expect(
      manager.addFile('QmE', 'QmFakeHash', init.deploymentToken, bytes)
    ).rejects.toThrow(/hash mismatch/i)
  })

  it('rejects when fileHash is not in the declared manifest', async () => {
    const bytes = Buffer.from([1, 2, 3])
    const realHash = await hashV1(bytes)
    const { manager } = makeManager()
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { 'QmSomeOtherHash': 99 }
    })
    expect(init.missingFiles).toContain('QmSomeOtherHash')
    await expect(
      manager.addFile('QmE', realHash, init.deploymentToken, bytes)
    ).rejects.toThrow(/not in manifest|unexpected/i)
  })

  it('rejects when bytes.length disagrees with manifest size', async () => {
    const bytes = Buffer.from([1, 2, 3])
    const realHash = await hashV1(bytes)
    const { manager } = makeManager()
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { [realHash]: 99 }
    })
    expect(init.missingFiles).toContain(realHash)
    await expect(
      manager.addFile('QmE', realHash, init.deploymentToken, bytes)
    ).rejects.toThrow(/size/i)
  })

  it('rejects when expiresAt has passed (lazy eviction)', async () => {
    const bytes = Buffer.from([1, 2, 3])
    const realHash = await hashV1(bytes)
    const { manager, store } = makeManager()
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { [realHash]: 3 }
    })
    const r = await store.get('QmE')
    r!.expiresAt = Date.now() - 1
    await expect(
      manager.addFile('QmE', realHash, init.deploymentToken, bytes)
    ).rejects.toThrow(/expired/i)
  })

  it('happy path: stores file, marks uploaded', async () => {
    const bytes = Buffer.from([1, 2, 3])
    const realHash = await hashV1(bytes)
    const { manager, store, tempStorage } = makeManager()
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: { [realHash]: 3 }
    })
    await manager.addFile('QmE', realHash, init.deploymentToken, bytes)

    const r = await store.get('QmE')
    expect(r!.uploadedHashes.has(realHash)).toBe(true)
    const stored = await tempStorage.getFile('QmE', realHash)
    expect([...stored]).toEqual([1, 2, 3])
  })
})

describe('partialDeploymentManager.complete', () => {
  it('rejects unknown deployment', async () => {
    const { manager } = makeManager()
    await expect(manager.complete('http://baseUrl', 'QmNope', 'tok')).rejects.toThrow(/not found/i)
  })

  it('rejects token mismatch', async () => {
    const { manager } = makeManager()
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: {}
    })
    expect(init.deploymentToken).toBeTruthy()
    await expect(manager.complete('http://x', 'QmE', 'wrong')).rejects.toThrow(/token/i)
  })

  it('rejects expired deployment', async () => {
    const { manager, store } = makeManager()
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: {}
    })
    const r = await store.get('QmE')
    r!.expiresAt = Date.now() - 1
    await expect(manager.complete('http://x', 'QmE', init.deploymentToken)).rejects.toThrow(/expired/i)
  })

  it('rejects when validator.final fails', async () => {
    const validator = {
      preflight: async () => ({ ok: () => true, errors: [] }),
      final: async () => ({ ok: () => false, errors: ['boom'] })
    }
    const { manager } = makeManager({ validator })
    const init = await manager.init({
      entityId: 'QmE',
      entityRaw: Buffer.from('{"content":[]}'),
      authChain: [],
      ownerAddress: '0xabc',
      manifest: {}
    })
    await expect(manager.complete('http://x', 'QmE', init.deploymentToken)).rejects.toThrow(/boom/)
  })

  it('happy path: validates, deploys, cleans up store + temp', async () => {
    const bytes = Buffer.from([1, 2, 3])
    const fileHash = await hashV1(bytes)
    const entityRaw = Buffer.from(JSON.stringify({ content: [{ file: 'a.glb', hash: fileHash }] }))
    const deployFn = jest.fn().mockResolvedValue({ message: 'deployed' })
    const storage = createInMemoryStorage()
    const store = createPartialDeploymentStore()
    const tempStorage = createPartialDeploymentTempStorage({ storage })
    const mutex = createMutex()
    const manager = createPartialDeploymentManager({
      storage,
      partialDeploymentStore: store,
      partialDeploymentTempStorage: tempStorage,
      partialDeploymentValidator: okValidator,
      entityDeployer: { deployEntity: deployFn } as any,
      logs: { getLogger: () => baseLogger } as any
    } as any, mutex)

    const init = await manager.init({
      entityId: 'QmE',
      entityRaw,
      authChain: [{ type: 'SIGNER' as any, payload: '0xabc', signature: '' }],
      ownerAddress: '0xabc',
      manifest: { [fileHash]: 3 }
    })
    await manager.addFile('QmE', fileHash, init.deploymentToken, bytes)
    const result = await manager.complete('http://baseUrl', 'QmE', init.deploymentToken)

    expect(result).toEqual({ message: 'deployed' })
    expect(deployFn).toHaveBeenCalled()
    // Cleanup verified: store + temp emptied
    expect(await store.get('QmE')).toBeUndefined()
    await expect(tempStorage.getEntityRaw('QmE')).rejects.toThrow()
    await expect(tempStorage.getFile('QmE', fileHash)).rejects.toThrow()
  })
})
