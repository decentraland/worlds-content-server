import { Readable } from 'stream'
import { Entity, EntityType } from '@dcl/schemas'
import { createEntityDeployer, DEFAULT_STORAGE_UPLOAD_CONCURRENCY } from '../../src/adapters/entity-deployer'
import { AppComponents, DeploymentFile, IEntityDeployer } from '../../src/types'

describe('entity deployer', () => {
  describe('when a deployment contains more missing files than the storage concurrency limit', () => {
    let activeContentUploads: number
    let maximumActiveContentUploads: number
    let contentHashes: string[]
    let storageStoreStream: jest.Mock
    let worldsDeployScene: jest.Mock
    let entity: Entity
    let files: Map<string, DeploymentFile>
    let configuredConcurrency: number
    let contentHashSet: Set<string>
    let contentUploadCalls: number
    let deployer: IEntityDeployer
    let components: Pick<
      AppComponents,
      'blocking' | 'config' | 'logs' | 'nameOwnership' | 'metrics' | 'storage' | 'snsClient' | 'worldsManager'
    >

    beforeEach(async () => {
      activeContentUploads = 0
      maximumActiveContentUploads = 0
      configuredConcurrency = 3
      contentHashes = Array.from({ length: DEFAULT_STORAGE_UPLOAD_CONCURRENCY + 2 }, (_, index) => `hash-${index}`)
      contentHashSet = new Set(contentHashes)
      storageStoreStream = jest.fn(async (hash: string) => {
        if (contentHashSet.has(hash)) {
          activeContentUploads++
          maximumActiveContentUploads = Math.max(maximumActiveContentUploads, activeContentUploads)
          await new Promise<void>((resolve) => setImmediate(resolve))
          activeContentUploads--
        }
      })
      worldsDeployScene = jest.fn().mockResolvedValue(undefined)
      entity = {
        id: 'entity-id',
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [
          ...contentHashes.map((hash, index) => ({ hash, file: `file-${index}` })),
          { hash: contentHashes[0], file: 'duplicate-reference' }
        ],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      } as Entity
      files = new Map(
        contentHashes.map((hash) => [
          hash,
          {
            size: 1,
            getStream: () => Readable.from('x'),
            getHash: async () => hash,
            asBuffer: async () => Buffer.from('x')
          }
        ])
      )
      components = {
        blocking: { unblockIfUnderQuota: jest.fn().mockResolvedValue(undefined) },
        config: {
          getNumber: jest.fn().mockResolvedValue(configuredConcurrency),
          getString: jest.fn().mockResolvedValue(undefined)
        },
        logs: {
          getLogger: jest.fn().mockReturnValue({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
        },
        metrics: { increment: jest.fn() },
        nameOwnership: {
          findOwners: jest.fn().mockResolvedValue(new Map([['world.dcl.eth', '0xowner']]))
        },
        snsClient: { publishMessage: jest.fn() },
        storage: { storeStream: storageStoreStream },
        worldsManager: { deployScene: worldsDeployScene }
      } as unknown as Pick<
        AppComponents,
        'blocking' | 'config' | 'logs' | 'nameOwnership' | 'metrics' | 'storage' | 'snsClient' | 'worldsManager'
      >
      deployer = createEntityDeployer(components)

      await deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map(contentHashes.map((hash) => [hash, false])),
        files,
        JSON.stringify(entity),
        [],
        12
      )
      contentUploadCalls = storageStoreStream.mock.calls.filter(([hash]) => contentHashes.includes(hash)).length
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should upload each unique content object with bounded concurrency and reuse deployment metadata', () => {
      expect({
        contentUploadCalls,
        maximumActiveContentUploads,
        deployment: worldsDeployScene.mock.calls[0][3]
      }).toEqual({
        contentUploadCalls: contentHashes.length,
        maximumActiveContentUploads: configuredConcurrency,
        deployment: { authChain: [], size: 12 }
      })
    })
  })

  describe('when one storage upload fails while another upload is still running', () => {
    let caughtError: unknown
    let completedUploads: string[]
    let startedUploads: string[]
    let storageStoreStream: jest.Mock
    let worldsDeployScene: jest.Mock
    let entity: Entity
    let files: Map<string, DeploymentFile>
    let contentHashes: string[]
    let deployer: IEntityDeployer
    let components: Pick<
      AppComponents,
      'blocking' | 'config' | 'logs' | 'nameOwnership' | 'metrics' | 'storage' | 'snsClient' | 'worldsManager'
    >

    beforeEach(async () => {
      completedUploads = []
      startedUploads = []
      contentHashes = ['hash-0', 'hash-1', 'hash-2']
      storageStoreStream = jest.fn(async (hash: string) => {
        startedUploads.push(hash)
        if (hash === 'hash-0') {
          await new Promise<void>((resolve) => setImmediate(resolve))
          throw new Error('storage failed')
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        completedUploads.push(hash)
      })
      worldsDeployScene = jest.fn().mockResolvedValue(undefined)
      entity = {
        id: 'entity-id',
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: contentHashes.map((hash) => ({ hash, file: hash })),
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      } as Entity
      files = new Map(
        contentHashes.map((hash) => [
          hash,
          {
            size: 1,
            getStream: () => Readable.from('x'),
            getHash: async () => hash,
            asBuffer: async () => Buffer.from('x')
          }
        ])
      )
      components = {
        blocking: { unblockIfUnderQuota: jest.fn().mockResolvedValue(undefined) },
        config: { getNumber: jest.fn().mockResolvedValue(2) },
        logs: {
          getLogger: jest.fn().mockReturnValue({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
        },
        metrics: { increment: jest.fn() },
        nameOwnership: { findOwners: jest.fn() },
        snsClient: { publishMessage: jest.fn() },
        storage: { storeStream: storageStoreStream },
        worldsManager: { deployScene: worldsDeployScene }
      } as unknown as typeof components
      deployer = createEntityDeployer(components)

      caughtError = await deployer
        .deployEntity(
          'https://worlds.example',
          entity,
          new Map(contentHashes.map((hash) => [hash, false])),
          files,
          JSON.stringify(entity),
          [],
          3
        )
        .catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should await the active upload and leave queued uploads unstarted before rethrowing', () => {
      expect({
        completedUploads,
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        startedUploads,
        worldDeployments: worldsDeployScene.mock.calls.length
      }).toEqual({
        completedUploads: ['hash-1'],
        error: 'storage failed',
        startedUploads: ['hash-0', 'hash-1'],
        worldDeployments: 0
      })
    })
  })

  describe('when some referenced content is already stored', () => {
    let storedFileGetStream: jest.Mock
    let uploadedContentHashes: string[]

    beforeEach(async () => {
      const storedHash = 'stored-hash'
      const missingHash = 'missing-hash'
      const contentHashes = new Set([storedHash, missingHash])
      storedFileGetStream = jest.fn(() => Readable.from('stored'))
      const storageStoreStream = jest.fn().mockResolvedValue(undefined)
      const entity = {
        id: 'entity-id',
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [
          { hash: storedHash, file: 'stored' },
          { hash: missingHash, file: 'missing' }
        ],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      } as Entity
      const files = new Map<string, DeploymentFile>([
        [
          storedHash,
          {
            size: 1,
            getStream: storedFileGetStream,
            getHash: async () => storedHash,
            asBuffer: async () => Buffer.from('stored')
          }
        ],
        [
          missingHash,
          {
            size: 1,
            getStream: () => Readable.from('missing'),
            getHash: async () => missingHash,
            asBuffer: async () => Buffer.from('missing')
          }
        ]
      ])
      const components = {
        blocking: { unblockIfUnderQuota: jest.fn().mockResolvedValue(undefined) },
        config: {
          getNumber: jest.fn().mockResolvedValue(2),
          getString: jest.fn().mockResolvedValue(undefined)
        },
        logs: {
          getLogger: jest.fn().mockReturnValue({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
        },
        metrics: { increment: jest.fn() },
        nameOwnership: {
          findOwners: jest.fn().mockResolvedValue(new Map([['world.dcl.eth', '0xowner']]))
        },
        snsClient: { publishMessage: jest.fn() },
        storage: { storeStream: storageStoreStream },
        worldsManager: { deployScene: jest.fn().mockResolvedValue(undefined) }
      } as unknown as Pick<
        AppComponents,
        'blocking' | 'config' | 'logs' | 'nameOwnership' | 'metrics' | 'storage' | 'snsClient' | 'worldsManager'
      >
      const deployer = createEntityDeployer(components)

      await deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map([
          [storedHash, true],
          [missingHash, false]
        ]),
        files,
        JSON.stringify(entity),
        [],
        2
      )
      uploadedContentHashes = storageStoreStream.mock.calls
        .map(([hash]) => hash)
        .filter((hash) => contentHashes.has(hash))
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should upload only missing content without opening the stored file', () => {
      expect({ storedFileReads: storedFileGetStream.mock.calls.length, uploadedContentHashes }).toEqual({
        storedFileReads: 0,
        uploadedContentHashes: ['missing-hash']
      })
    })
  })
})
