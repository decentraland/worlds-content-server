import { Readable } from 'stream'
import { Authenticator } from '@dcl/crypto'
import { Entity, EntityType, Events, WorldSettingsChangedEvent } from '@dcl/schemas'
import { generateLazyValidator } from '@dcl/schemas/dist/validation'
import { createEntityDeployer, DEFAULT_STORAGE_UPLOAD_CONCURRENCY } from '../../src/adapters/entity-deployer'
import { AppComponents, DeploymentFile, IEntityDeployer } from '../../src/types'
import { createDeploymentProcessingMock } from '../mocks/deployment-processing-mock'
import { createSceneDeployment } from './validations/shared'
import { getIdentity } from '../utils'

const unrestrictedReplacementAuthorization = { mode: 'unrestricted-owner' } as const

// The consumer discards events that fail this schema, so pin the emitted shape against it
const validateWorldSettingsChangedEvent = generateLazyValidator(WorldSettingsChangedEvent.schema)

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
): {
  components: EntityDeployerComponents
  loggerError: jest.Mock
  loggerWarn: jest.Mock
  worldsDeployScene: jest.Mock
  worldsGetWorldSettings: jest.Mock
} {
  const worldsDeployScene = jest.fn().mockResolvedValue({ metadataUpdated: false })
  const worldsGetWorldSettings = jest.fn().mockResolvedValue(undefined)
  const loggerError = jest.fn()
  const loggerWarn = jest.fn()
  const components = {
    blocking: { unblockIfUnderQuota: jest.fn().mockResolvedValue(undefined) },
    config: { getString: jest.fn().mockResolvedValue(undefined) },
    deploymentProcessing: createDeploymentProcessingMock({ storageConcurrency }),
    logs: {
      getLogger: jest.fn().mockReturnValue({ debug: jest.fn(), info: jest.fn(), warn: loggerWarn, error: loggerError })
    },
    metrics: { increment: jest.fn() },
    nameOwnership: {
      findOwners: jest.fn().mockResolvedValue(new Map([['world.dcl.eth', '0xowner']]))
    },
    snsClient: { publishMessage: jest.fn().mockResolvedValue({ MessageId: 'mid', SequenceNumber: 'seq' }) },
    storage: { storeStream: storageStoreStream },
    worldsManager: { deployScene: worldsDeployScene, getWorldSettings: worldsGetWorldSettings }
  } as unknown as EntityDeployerComponents
  return { components, loggerError, loggerWarn, worldsDeployScene, worldsGetWorldSettings }
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
        12,
        undefined,
        undefined,
        unrestrictedReplacementAuthorization
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
        authorization: worldsDeployScene.mock.calls[0][3],
        deployment: worldsDeployScene.mock.calls[0][4]
      }).toEqual({
        contentUploadCalls: contentHashes.length,
        maximumActiveContentUploads: configuredConcurrency,
        authorization: unrestrictedReplacementAuthorization,
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
        2,
        undefined,
        undefined,
        unrestrictedReplacementAuthorization
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
    let storageStoreStream: jest.Mock

    beforeEach(async () => {
      const controller = new AbortController()
      const contentHashes = ['hash-0', 'hash-1', 'hash-2']
      signals = []
      startedUploads = []
      storageStoreStream = jest.fn(async (hash: string) => {
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

    it('should pass cancellation to active streams and uploads and leave queued uploads unstarted', () => {
      expect({
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        signals,
        startedUploads,
        uploadSignals: storageStoreStream.mock.calls.map((call) => call[2])
      }).toEqual({
        error: 'client disconnected',
        signals: [expect.any(AbortSignal), expect.any(AbortSignal)],
        startedUploads: ['hash-0', 'hash-1'],
        uploadSignals: [expect.any(AbortSignal), expect.any(AbortSignal)]
      })
    })
  })

  describe('when the request is aborted while a content upload never settles', () => {
    let caughtError: unknown
    let worldsDeployScene: jest.Mock

    beforeEach(async () => {
      const controller = new AbortController()
      const contentHashes = ['hash-0', 'hash-1']
      const storageStoreStream = jest.fn((hash: string) =>
        hash === 'hash-0' ? new Promise<void>(() => undefined) : Promise.resolve()
      )
      const setup = createComponents(storageStoreStream, 2)
      worldsDeployScene = setup.worldsDeployScene
      const entity = createScene(contentHashes)
      const files = new Map(contentHashes.map((hash) => [hash, createDeploymentFile(hash)]))
      const deployer: IEntityDeployer = createEntityDeployer(setup.components)

      const deployment = deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map(contentHashes.map((hash) => [hash, false])),
        files,
        JSON.stringify(entity),
        [],
        2,
        controller.signal
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      controller.abort(new Error('deadline exceeded'))
      caughtError = await deployment.catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject with the abort reason instead of waiting for the wedged upload', () => {
      expect({
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        worldDeployments: worldsDeployScene.mock.calls.length
      }).toEqual({
        error: 'deadline exceeded',
        worldDeployments: 0
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
      setup.worldsDeployScene.mockImplementation(async (_worldName, _entity, _owner, _authorization, deployment) => {
        signalPassedToPersistence = deployment.signal
        controller.abort(new Error('deadline exceeded after commit'))
        return { metadataUpdated: false }
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
        Date.now() + 10,
        unrestrictedReplacementAuthorization
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
        0,
        undefined,
        undefined,
        unrestrictedReplacementAuthorization
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

  describe('when a deployment refreshed the world metadata', () => {
    let publishMessage: jest.Mock

    beforeEach(async () => {
      const setup = createComponents(jest.fn().mockResolvedValue(undefined), 2)
      ;(setup.components.config.getString as jest.Mock).mockResolvedValue('some-arn')
      setup.worldsDeployScene.mockResolvedValue({ metadataUpdated: true })
      setup.worldsGetWorldSettings.mockResolvedValue({
        title: 'A Title',
        description: 'A Description',
        contentRating: 'T',
        spawnCoordinates: '0,0',
        skyboxTime: 3600,
        categories: ['art'],
        singlePlayer: false,
        showInPlaces: true,
        thumbnailHash: 'thumb-hash',
        settingsVersion: 7
      })
      publishMessage = setup.components.snsClient.publishMessage as jest.Mock

      const entity = createScene([])
      const deployer = createEntityDeployer(setup.components)
      await deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map(),
        new Map(),
        JSON.stringify(entity),
        [],
        12,
        undefined,
        undefined,
        unrestrictedReplacementAuthorization
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should publish the deployment event and the settings changed event', () => {
      expect(publishMessage.mock.calls.map(([event]) => event.subType)).toEqual([
        Events.SubType.Worlds.DEPLOYMENT,
        Events.SubType.Worlds.WORLD_SETTINGS_CHANGED
      ])
    })

    it('should publish every stored setting in the event metadata', () => {
      const settingsEvent = publishMessage.mock.calls
        .map(([event]) => event)
        .find((event) => event.subType === Events.SubType.Worlds.WORLD_SETTINGS_CHANGED)

      expect(settingsEvent).toEqual({
        type: Events.Type.WORLD,
        subType: Events.SubType.Worlds.WORLD_SETTINGS_CHANGED,
        key: `world.dcl.eth-${settingsEvent.timestamp}`,
        timestamp: expect.any(Number),
        metadata: {
          worldName: 'world.dcl.eth',
          title: 'A Title',
          description: 'A Description',
          contentRating: 'T',
          skyboxTime: 3600,
          categories: ['art'],
          singlePlayer: false,
          showInPlaces: true,
          thumbnailUrl: 'https://worlds.example/contents/thumb-hash'
        }
      })
    })

    it('should validate against the published event schema', () => {
      const settingsEvent = publishMessage.mock.calls
        .map(([event]) => event)
        .find((event) => event.subType === Events.SubType.Worlds.WORLD_SETTINGS_CHANGED)

      expect(validateWorldSettingsChangedEvent(JSON.parse(JSON.stringify(settingsEvent)))).toBe(true)
    })
  })

  describe('and the deployment event publish fails', () => {
    let publishMessage: jest.Mock
    let loggerError: jest.Mock

    beforeEach(async () => {
      const setup = createComponents(jest.fn().mockResolvedValue(undefined), 2)
      ;(setup.components.config.getString as jest.Mock).mockResolvedValue('some-arn')
      setup.worldsDeployScene.mockResolvedValue({ metadataUpdated: true })
      setup.worldsGetWorldSettings.mockResolvedValue({ title: 'A Title' })
      loggerError = setup.loggerError
      publishMessage = setup.components.snsClient.publishMessage as jest.Mock
      publishMessage.mockImplementation(async (event: { subType: string }) => {
        if (event.subType === Events.SubType.Worlds.DEPLOYMENT) {
          throw new Error('sns unavailable')
        }
        return { MessageId: 'mid', SequenceNumber: 'seq' }
      })

      const entity = createScene([])
      const deployer = createEntityDeployer(setup.components)
      await deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map(),
        new Map(),
        JSON.stringify(entity),
        [],
        12,
        undefined,
        undefined,
        unrestrictedReplacementAuthorization
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should still publish the settings changed event', () => {
      expect(publishMessage.mock.calls.map(([event]) => event.subType)).toContain(
        Events.SubType.Worlds.WORLD_SETTINGS_CHANGED
      )
    })

    it('should report which post-deployment task failed', () => {
      expect(loggerError).toHaveBeenCalledWith(
        'Post-deployment work failed after the scene was committed',
        expect.objectContaining({ task: 'publishDeployment', error: 'sns unavailable' })
      )
    })
  })

  describe('and the world settings are unavailable after the refresh', () => {
    let publishMessage: jest.Mock
    let loggerWarn: jest.Mock

    beforeEach(async () => {
      const setup = createComponents(jest.fn().mockResolvedValue(undefined), 2)
      ;(setup.components.config.getString as jest.Mock).mockResolvedValue('some-arn')
      setup.worldsDeployScene.mockResolvedValue({ metadataUpdated: true })
      setup.worldsGetWorldSettings.mockResolvedValue(undefined)
      loggerWarn = setup.loggerWarn
      publishMessage = setup.components.snsClient.publishMessage as jest.Mock

      const entity = createScene([])
      const deployer = createEntityDeployer(setup.components)
      await deployer.deployEntity(
        'https://worlds.example',
        entity,
        new Map(),
        new Map(),
        JSON.stringify(entity),
        [],
        12,
        undefined,
        undefined,
        unrestrictedReplacementAuthorization
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should publish only the deployment event', () => {
      expect(publishMessage.mock.calls.map(([event]) => event.subType)).toEqual([Events.SubType.Worlds.DEPLOYMENT])
    })

    it('should warn that the settings event was skipped', () => {
      expect(loggerWarn).toHaveBeenCalledWith(
        'world settings unavailable after a committed metadata refresh; event skipped',
        expect.objectContaining({ worldName: 'world.dcl.eth' })
      )
    })
  })

  it('uses the auth-chain owner when name ownership validation is ignored', async () => {
    const identity = await getIdentity()
    const deployment = await createSceneDeployment(identity.authChain)
    const setup = createComponents(jest.fn().mockResolvedValue(undefined), 2)
    ;(setup.components.config.getString as jest.Mock).mockImplementation(async (key: string) =>
      key === 'IGNORE_NAME_OWNERSHIP_VALIDATION' ? 'true' : undefined
    )
    const deployer = createEntityDeployer(setup.components)

    await deployer.deployEntity(
      'https://worlds.example',
      deployment.entity,
      deployment.contentHashesInStorage,
      deployment.files,
      JSON.stringify(deployment.entity),
      deployment.authChain,
      0,
      undefined,
      undefined,
      unrestrictedReplacementAuthorization
    )

    expect(setup.worldsDeployScene).toHaveBeenCalledWith(
      'whatever.dcl.eth',
      deployment.entity,
      Authenticator.ownerAddress(deployment.authChain),
      unrestrictedReplacementAuthorization,
      expect.objectContaining({ authChain: deployment.authChain, size: 0 })
    )
    expect(setup.components.nameOwnership.findOwners).not.toHaveBeenCalled()
  })
})
