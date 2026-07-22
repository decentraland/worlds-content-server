import { Readable } from 'stream'
import { Entity, EntityType } from '@dcl/schemas'
import { createEntityDeployer, DEFAULT_STORAGE_UPLOAD_CONCURRENCY } from '../../src/adapters/entity-deployer'
import { AppComponents, DeploymentFile, IEntityDeployer } from '../../src/types'
import { createDeploymentProcessingMock } from '../mocks/deployment-processing-mock'

type EntityDeployerComponents = Pick<
  AppComponents,
  | 'blocking'
  | 'config'
  | 'deploymentProcessing'
  | 'logs'
  | 'nameOwnership'
  | 'metrics'
  | 'storage'
  | 'snsClient'
  | 'worldsManager'
>

function createScene(contentHashes: string[], duplicateFirstHash: boolean = false): Entity {
  return {
    id: 'entity-id',
    type: EntityType.SCENE,
    pointers: ['0,0'],
    timestamp: Date.now(),
    content: [
      ...contentHashes.map((hash, index) => ({ hash, file: `file-${index}` })),
      ...(duplicateFirstHash ? [{ hash: contentHashes[0], file: 'duplicate-reference' }] : [])
    ],
    metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
  } as Entity
}

function createDeploymentFile(
  hash: string,
  getStream: DeploymentFile['getStream'] = () => Readable.from('x')
): DeploymentFile {
  return {
    size: 1,
    getStream,
    getHash: async () => hash,
    asBuffer: async () => Buffer.from('x')
  }
}

function createComponents(
  storageStoreStream: jest.Mock,
  storageConcurrency: number
): { components: EntityDeployerComponents; loggerError: jest.Mock; worldsDeployScene: jest.Mock } {
  const worldsDeployScene = jest.fn().mockResolvedValue(undefined)
  const loggerError = jest.fn()
  const components = {
    blocking: { unblockIfUnderQuota: jest.fn().mockResolvedValue(undefined) },
    config: { getString: jest.fn().mockResolvedValue(undefined) },
    deploymentProcessing: createDeploymentProcessingMock({ storageConcurrency }),
    logs: {
      getLogger: jest.fn().mockReturnValue({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: loggerError })
    },
    metrics: { increment: jest.fn() },
    nameOwnership: {
      findOwners: jest.fn().mockResolvedValue(new Map([['world.dcl.eth', '0xowner']]))
    },
    snsClient: { publishMessage: jest.fn() },
    storage: { storeStream: storageStoreStream },
    worldsManager: { deployScene: worldsDeployScene, hasNewerDeployedScene: jest.fn().mockResolvedValue(false) }
  } as unknown as EntityDeployerComponents
  return { components, loggerError, worldsDeployScene }
}

describe('entity deployer', () => {
  describe('when a deployment contains more missing files than the storage concurrency limit', () => {
    let configuredConcurrency: number
    let contentHashes: string[]
    let contentUploadCalls: number
    let maximumActiveContentUploads: number
    let worldsDeployScene: jest.Mock

    beforeEach(async () => {
      let activeContentUploads = 0
      configuredConcurrency = 3
      contentHashes = Array.from({ length: DEFAULT_STORAGE_UPLOAD_CONCURRENCY + 2 }, (_, index) => `hash-${index}`)
      const contentHashSet = new Set(contentHashes)
      maximumActiveContentUploads = 0
      const storageStoreStream = jest.fn(async (hash: string) => {
        if (contentHashSet.has(hash)) {
          activeContentUploads++
          maximumActiveContentUploads = Math.max(maximumActiveContentUploads, activeContentUploads)
          await new Promise<void>((resolve) => setImmediate(resolve))
          activeContentUploads--
        }
      })
      const setup = createComponents(storageStoreStream, configuredConcurrency)
      worldsDeployScene = setup.worldsDeployScene
      const entity = createScene(contentHashes, true)
      const files = new Map(contentHashes.map((hash) => [hash, createDeploymentFile(hash)]))
      const deployer = createEntityDeployer(setup.components)

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
      // The real-timer paced uploads can exceed the default 5s hook budget when jest runs the
      // full suite with many parallel workers on a loaded machine.
    }, 30_000)

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
    let worldsDeployScene: jest.Mock

    beforeEach(async () => {
      completedUploads = []
      startedUploads = []
      const contentHashes = ['hash-0', 'hash-1', 'hash-2']
      const storageStoreStream = jest.fn(async (hash: string) => {
        startedUploads.push(hash)
        if (hash === 'hash-0') {
          await new Promise<void>((resolve) => setImmediate(resolve))
          throw new Error('storage failed')
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        completedUploads.push(hash)
      })
      const setup = createComponents(storageStoreStream, 2)
      worldsDeployScene = setup.worldsDeployScene
      const entity = createScene(contentHashes)
      const files = new Map(contentHashes.map((hash) => [hash, createDeploymentFile(hash)]))
      const deployer = createEntityDeployer(setup.components)

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
      const setup = createComponents(storageStoreStream, 2)
      const entity = createScene([storedHash, missingHash])
      const files = new Map<string, DeploymentFile>([
        [storedHash, createDeploymentFile(storedHash, storedFileGetStream)],
        [missingHash, createDeploymentFile(missingHash, () => Readable.from('missing'))]
      ])
      const deployer = createEntityDeployer(setup.components)

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

  describe('when the request is aborted during content storage', () => {
    let caughtError: unknown
    let signals: Array<AbortSignal | undefined>
    let startedUploads: string[]

    beforeEach(async () => {
      const controller = new AbortController()
      const contentHashes = ['hash-0', 'hash-1', 'hash-2']
      signals = []
      startedUploads = []
      const storageStoreStream = jest.fn(async (hash: string) => {
        startedUploads.push(hash)
        if (hash === 'hash-0') {
          await new Promise<void>((resolve) => setImmediate(resolve))
          controller.abort(new Error('client disconnected'))
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
        }
      })
      const setup = createComponents(storageStoreStream, 2)
      const entity = createScene(contentHashes)
      const files = new Map(
        contentHashes.map((hash) => [
          hash,
          createDeploymentFile(hash, (signal) => {
            signals.push(signal)
            return Readable.from('x')
          })
        ])
      )
      const deployer: IEntityDeployer = createEntityDeployer(setup.components)

      caughtError = await deployer
        .deployEntity(
          'https://worlds.example',
          entity,
          new Map(contentHashes.map((hash) => [hash, false])),
          files,
          JSON.stringify(entity),
          [],
          3,
          controller.signal
        )
        .catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should pass cancellation to active streams and leave queued uploads unstarted', () => {
      expect({
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        signals,
        startedUploads
      }).toEqual({
        error: 'client disconnected',
        signals: [expect.any(AbortSignal), expect.any(AbortSignal)],
        startedUploads: ['hash-0', 'hash-1']
      })
    })
  })

  describe('when the processing deadline expires after persistence commits', () => {
    let deploymentResult: Awaited<ReturnType<IEntityDeployer['deployEntity']>>
    let releasePostCommitWork: () => void
    let signalPassedToPersistence: AbortSignal | undefined

    beforeEach(async () => {
      const controller = new AbortController()
      const contentHashes: string[] = []
      const storageStoreStream = jest.fn().mockResolvedValue(undefined)
      const setup = createComponents(storageStoreStream, 2)
      const postCommitWork = new Promise<void>((resolve) => {
        releasePostCommitWork = resolve
      })
      setup.components.blocking.unblockIfUnderQuota = jest.fn(async () => postCommitWork) as jest.Mock
      setup.worldsDeployScene.mockImplementation(async (_worldName, _entity, _owner, deployment) => {
        signalPassedToPersistence = deployment.signal
        controller.abort(new Error('deadline exceeded after commit'))
      })
      const entity = createScene(contentHashes)
      const deployer = createEntityDeployer(setup.components)

      deploymentResult = await deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map(),
        new Map(),
        JSON.stringify(entity),
        [],
        0,
        controller.signal,
        Date.now() + 10
      )
    })

    afterEach(async () => {
      releasePostCommitWork()
      await new Promise<void>((resolve) => setImmediate(resolve))
      jest.resetAllMocks()
    })

    it('should preserve the committed success while passing cancellation into persistence', () => {
      expect({ deploymentResult, signalPassedToPersistence }).toEqual({
        deploymentResult: expect.objectContaining({ message: expect.stringContaining('was deployed') }),
        signalPassedToPersistence: expect.any(AbortSignal)
      })
    })
  })

  describe('when post-commit notification delivery fails', () => {
    let deploymentResult: Awaited<ReturnType<IEntityDeployer['deployEntity']>>
    let loggerError: jest.Mock

    beforeEach(async () => {
      const storageStoreStream = jest.fn().mockResolvedValue(undefined)
      const setup = createComponents(storageStoreStream, 2)
      loggerError = setup.loggerError
      setup.components.config.getString = jest.fn().mockResolvedValue('arn:test') as jest.Mock
      setup.components.snsClient.publishMessage = jest.fn().mockRejectedValue(new Error('SNS unavailable')) as jest.Mock
      const entity = createScene([])
      const deployer = createEntityDeployer(setup.components)

      deploymentResult = await deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map(),
        new Map(),
        JSON.stringify(entity),
        [],
        0
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should keep the committed deployment successful and log the best-effort failure', () => {
      expect({ deploymentResult, loggedFailure: loggerError.mock.calls[0] }).toEqual({
        deploymentResult: expect.objectContaining({ message: expect.stringContaining('was deployed') }),
        loggedFailure: [
          'Post-deployment work failed after the scene was committed',
          expect.objectContaining({ error: 'SNS unavailable', entityId: 'entity-id', worldName: 'world.dcl.eth' })
        ]
      })
    })
  })

  describe('when deploying an entity type without a post-deployment hook', () => {
    let deploymentResult: unknown
    let worldsDeployScene: jest.Mock

    beforeEach(async () => {
      const setup = createComponents(jest.fn().mockResolvedValue(undefined), 2)
      worldsDeployScene = setup.worldsDeployScene
      const entity = {
        id: 'entity-id',
        type: EntityType.PROFILE,
        pointers: ['0xdeployer'],
        timestamp: Date.now(),
        content: [],
        metadata: {}
      } as Entity
      const deployer = createEntityDeployer(setup.components)

      deploymentResult = await deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map(),
        new Map(),
        JSON.stringify(entity),
        [],
        0
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should store the entity without running scene persistence and report the missing hook', () => {
      expect({ deploymentResult, worldDeployments: worldsDeployScene.mock.calls.length }).toEqual({
        deploymentResult: { message: 'No post deployment hook for this entity type' },
        worldDeployments: 0
      })
    })
  })

  describe('when the world name has no resolvable owner', () => {
    let caughtError: unknown
    let worldsDeployScene: jest.Mock

    beforeEach(async () => {
      const setup = createComponents(jest.fn().mockResolvedValue(undefined), 2)
      worldsDeployScene = setup.worldsDeployScene
      ;(setup.components.nameOwnership.findOwners as jest.Mock).mockResolvedValue(new Map())
      const entity = createScene([])
      const deployer = createEntityDeployer(setup.components)

      caughtError = await deployer
        .deployEntity('https://worlds.example', entity, new Map(), new Map(), JSON.stringify(entity), [], 0)
        .catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject the deployment before persisting the scene', () => {
      expect({
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        worldDeployments: worldsDeployScene.mock.calls.length
      }).toEqual({
        error: 'Cannot deploy scene "entity-id" to world "world.dcl.eth": owner address could not be resolved.',
        worldDeployments: 0
      })
    })
  })
})
