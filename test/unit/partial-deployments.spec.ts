import { AuthLinkType, EntityType } from '@dcl/schemas'
import { createPartialDeploymentsComponent } from '../../src/logic/partial-deployments'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { createDeploymentProcessingMock } from '../mocks/deployment-processing-mock'
import { DeploymentToValidate } from '../../src/types'
import { StageDeploymentInput } from '../../src/logic/partial-deployments/types'
import { PartialUploadExpiredError } from '../../src/adapters/pending-scenes-manager'

type Components = Parameters<typeof createPartialDeploymentsComponent>[0]

describe('when staging a partial deployment', () => {
  let components: Components
  let input: StageDeploymentInput
  let fileInfo: jest.Mock
  let getProgress: jest.Mock
  let getPending: jest.Mock
  let reserve: jest.Mock
  let storeStream: jest.Mock
  let validateStaging: jest.Mock
  let validate: jest.Mock
  let deployEntity: jest.Mock
  let upsert: jest.Mock
  let getWorldScenes: jest.Mock
  let getCompleted: jest.Mock
  let deleteByEntityId: jest.Mock
  let discardUnadmitted: jest.Mock
  let increment: jest.Mock
  let observe: jest.Mock
  let stage: Awaited<ReturnType<typeof createPartialDeploymentsComponent>>['stage']

  beforeEach(async () => {
    input = {
      baseUrl: 'https://worlds.example',
      entityRaw: '{}',
      entity: {
        version: 'v3',
        id: 'entity',
        type: EntityType.SCENE,
        timestamp: Date.now(),
        pointers: ['0,0'],
        content: [
          { file: 'a', hash: 'a' },
          { file: 'b', hash: 'b' }
        ],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { base: '0,0', parcels: ['0,0'] } }
      },
      authChain: [{ type: AuthLinkType.SIGNER, payload: 'deployer', signature: '' }],
      files: new Map([['a', { size: 300, getStream: jest.fn(), getHash: jest.fn(), asBuffer: jest.fn() }]]),
      requestArrivedAt: Date.now() - 1_000
    }
    fileInfo = jest.fn().mockResolvedValue(undefined)
    getProgress = jest.fn().mockResolvedValue(new Map([['a', 300]]))
    getPending = jest.fn().mockResolvedValue(undefined)
    reserve = jest.fn().mockResolvedValue(undefined)
    storeStream = jest.fn().mockResolvedValue(undefined)
    validateStaging = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })
    validate = jest.fn(async (deployment: DeploymentToValidate) => {
      deployment.sceneReplacementAuthorization = { mode: 'unrestricted-owner' }
      return { ok: () => true, errors: [] }
    })
    deployEntity = jest.fn().mockResolvedValue({ message: 'deployed', creationTimestamp: 123 })
    upsert = jest.fn().mockResolvedValue({ createdAt: new Date() })
    getWorldScenes = jest.fn().mockResolvedValue({ scenes: [], total: 0 })
    getCompleted = jest.fn().mockResolvedValue({ creationTimestamp: 123 })
    deleteByEntityId = jest.fn().mockResolvedValue(undefined)
    discardUnadmitted = jest.fn().mockResolvedValue(undefined)
    increment = jest.fn()
    observe = jest.fn()
    components = {
      config: { getNumber: jest.fn().mockResolvedValue(undefined) },
      coordinates: createCoordinatesComponent(),
      deploymentProcessing: createDeploymentProcessingMock(),
      entityDeployer: { deployEntity },
      limitsManager: { getMaxAllowedSizeInBytesFor: jest.fn().mockResolvedValue(10000n) },
      logs: { getLogger: jest.fn() },
      metrics: { increment, observe },
      pendingScenesManager: {
        ttlMs: 86_400_000,
        getByEntityId: getPending,
        upsert,
        reserve,
        recordStored: jest.fn().mockResolvedValue(2),
        getProgress,
        markMissing: jest.fn(),
        getCompleted,
        deleteByEntityId,
        discardUnadmitted
      },
      storage: { fileInfo, storeStream },
      validator: { validateStaging, validate },
      worldsManager: { hasNewerDeployedScene: jest.fn().mockResolvedValue(false), getWorldScenes }
    } as unknown as Components
    ;({ stage } = await createPartialDeploymentsComponent(components))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and validation rejects the manifest', () => {
    beforeEach(() => {
      validateStaging.mockResolvedValueOnce({ ok: () => false, errors: ['invalid manifest'] })
    })
    it('should reject before looking up storage or reserving bytes', async () => {
      await expect(stage(input)).rejects.toThrow('invalid manifest')
      expect({ metadata: fileInfo.mock.calls.length, reservations: reserve.mock.calls.length }).toEqual({
        metadata: 0,
        reservations: 0
      })
    })
  })

  describe('and the batch admits a new upload', () => {
    beforeEach(async () => {
      await stage(input)
    })

    it('should create the upload at the instant its freshness was validated', () => {
      expect(upsert.mock.calls[0][0].admittedAt).toBe(validateStaging.mock.calls[0][0].pendingCreatedAt)
    })

    it('should admit it at the request arrival', () => {
      expect(upsert.mock.calls[0][0].admittedAt).toEqual(new Date(input.requestArrivedAt))
    })

    it('should let the upload be created', () => {
      expect(upsert.mock.calls[0][0].resumes).toBe(false)
    })

    it('should count it as a started upload', () => {
      expect(increment).toHaveBeenCalledWith('partial_uploads_started')
    })
  })

  describe('and the upload expires before the batch stores its files', () => {
    let caughtError: unknown

    beforeEach(async () => {
      upsert.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 86_400_000) })
      caughtError = await stage(input).catch((error: unknown) => error)
    })

    it('should reject the batch as expired', () => {
      expect(caughtError).toBeInstanceOf(PartialUploadExpiredError)
    })

    it('should not store any of its files', () => {
      expect(storeStream).not.toHaveBeenCalled()
    })
  })

  describe('and the batch resumes an existing upload', () => {
    let createdAt: Date

    beforeEach(async () => {
      createdAt = new Date(5_000)
      getPending.mockResolvedValueOnce({ createdAt, deployer: 'deployer', initialized: true })
      await stage(input)
    })

    it('should validate freshness against the upload admission', () => {
      expect(validateStaging.mock.calls[0][0].pendingCreatedAt).toBe(createdAt)
    })

    it('should require the upload to still exist instead of re-creating it', () => {
      expect(upsert.mock.calls[0][0].resumes).toBe(true)
    })
  })

  describe('and a resumed batch is still incomplete', () => {
    beforeEach(() => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
    })
    it('should report missing hashes without querying storage metadata', async () => {
      expect(await stage(input)).toEqual({ complete: false, missing: ['b'] })
      expect(fileInfo).not.toHaveBeenCalled()
    })
  })

  describe('and the staging budget is exhausted', () => {
    beforeEach(() => {
      reserve.mockRejectedValueOnce(new Error('budget exceeded'))
    })
    it('should reject before any storage write', async () => {
      await expect(stage(input)).rejects.toThrow('budget exceeded')
      expect(storeStream).not.toHaveBeenCalled()
    })
  })

  describe('and a resumed batch completes the manifest', () => {
    beforeEach(() => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(
        new Map([
          ['a', 300],
          ['b', 500]
        ])
      )
      fileInfo.mockImplementation(async (hash) => ({ size: hash === 'a' ? 300 : 500 }))
      input.signal = new AbortController().signal
      input.deadlineAt = Date.now() + 60000
    })
    it('should persist verified total size and preserve the completion timestamp', async () => {
      expect(await stage(input)).toEqual({
        complete: true,
        result: { message: 'deployed', creationTimestamp: 123 },
        creationTimestamp: 123
      })
      expect(deployEntity.mock.calls[0].slice(6, 9)).toEqual([800, input.signal, input.deadlineAt])
    })
    it('should perform only one final metadata pass', async () => {
      await stage(input)
      expect(fileInfo.mock.calls.map(([hash]) => hash)).toEqual(['a', 'b'])
    })
    it('should pass the request signal into storage writes', async () => {
      await stage(input)
      expect(storeStream.mock.calls[0][2]).toBe(input.signal)
    })
    describe('and the upload is published', () => {
      let createdAt: Date

      beforeEach(async () => {
        createdAt = new Date(Date.now() - 5_000)
        upsert.mockResolvedValueOnce({ createdAt })
        await stage(input)
      })

      it('should mark the publication as a partial finalization that expires with the upload', () => {
        expect(deployEntity.mock.calls[0][10]).toEqual({
          completesPartialUpload: { expiresAt: createdAt.getTime() + 86_400_000 }
        })
      })

      it('should report the completed upload with its batches and its duration since admission', () => {
        expect({
          completed: increment.mock.calls.filter(([name]) => name === 'partial_uploads_completed'),
          started: increment.mock.calls.filter(([name]) => name === 'partial_uploads_started'),
          batches: observe.mock.calls.filter(([name]) => name === 'partial_upload_batches_per_upload'),
          lastedAtLeastItsAge: observe.mock.calls
            .filter(([name]) => name === 'partial_upload_duration_seconds')
            .map(([, , seconds]) => seconds >= 5)
        }).toEqual({
          completed: [['partial_uploads_completed']],
          started: [],
          batches: [['partial_upload_batches_per_upload', {}, 2]],
          lastedAtLeastItsAge: [true]
        })
      })
    })
    describe('and storage has lost a previously acknowledged file', () => {
      beforeEach(() => {
        fileInfo.mockResolvedValueOnce(undefined)
      })
      it('should invalidate its receipt and request that file again', async () => {
        expect(await stage(input)).toEqual({ complete: false, missing: ['a'] })
        expect(components.pendingScenesManager.markMissing).toHaveBeenCalledWith('entity', ['a'], input.signal)
        expect(deployEntity).not.toHaveBeenCalled()
      })
    })
  })

  describe('and the request is already cancelled', () => {
    beforeEach(() => {
      input.signal = AbortSignal.abort(new Error('cancelled'))
    })
    it('should reject without looking up pending state', async () => {
      await expect(stage(input)).rejects.toThrow('cancelled')
      expect(getPending).not.toHaveBeenCalled()
    })
  })
  describe('and a resume batch omits the manifest', () => {
    let validatedFiles: string[]

    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      input.manifest = { size: 40, getStream: jest.fn(), getHash: jest.fn(), asBuffer: jest.fn() }
      await stage(input)
      validatedFiles = Array.from((validateStaging.mock.calls[0][0] as DeploymentToValidate).files.keys())
    })

    it('should validate the manifest but only charge and store the uploaded files', () => {
      expect({
        validatedFiles,
        incomingBytes: reserve.mock.calls[0][3],
        stored: storeStream.mock.calls.map(([hash]) => hash)
      }).toEqual({ validatedFiles: ['a', 'entity'], incomingBytes: 300, stored: ['a'] })
    })
  })

  describe('and publication collides with a concurrent publication of the same entity', () => {
    let result: Awaited<ReturnType<typeof stage>>

    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(
        new Map([
          ['a', 300],
          ['b', 500]
        ])
      )
      fileInfo.mockImplementation(async (hash) => ({ size: hash === 'a' ? 300 : 500 }))
      deployEntity.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      getWorldScenes.mockResolvedValueOnce({
        scenes: [
          {
            entityId: 'entity',
            worldName: 'world.dcl.eth',
            parcels: ['0,0'],
            entity: input.entity,
            createdAt: new Date(456)
          }
        ],
        total: 1
      })
      // No completion receipt for this signer: the live publication answers regardless.
      getCompleted.mockResolvedValue(undefined)
      result = await stage(input)
    })

    it('should drop this request staging state and answer with the live publication', () => {
      expect({ result, cleaned: deleteByEntityId.mock.calls }).toEqual({
        result: {
          complete: true,
          creationTimestamp: 456,
          result: { message: expect.stringContaining('world.dcl.eth') }
        },
        cleaned: [['entity']]
      })
    })
  })

  describe('and publication fails with a unique violation while the entity is not published', () => {
    let error: unknown

    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(
        new Map([
          ['a', 300],
          ['b', 500]
        ])
      )
      fileInfo.mockImplementation(async (hash) => ({ size: hash === 'a' ? 300 : 500 }))
      deployEntity.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      error = await stage(input).catch((e) => e)
    })

    it('should propagate the original collision', () => {
      expect(error).toMatchObject({ message: 'duplicate key', code: '23505' })
    })
  })
  describe('and the first batch of an upload is not admitted', () => {
    let error: unknown

    beforeEach(async () => {
      reserve.mockRejectedValueOnce(new Error('budget exceeded'))
      error = await stage(input).catch((e) => e)
    })

    it('should discard the upload it created so it does not hold a slot of the cap', () => {
      expect({ error, discarded: discardUnadmitted.mock.calls }).toEqual({
        error: new Error('budget exceeded'),
        discarded: [['entity']]
      })
    })
  })

  describe('and a later batch of an upload is not admitted', () => {
    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      reserve.mockRejectedValueOnce(new Error('rate exceeded'))
      await stage(input).catch(() => undefined)
    })

    it('should keep the existing upload', () => {
      expect(discardUnadmitted).not.toHaveBeenCalled()
    })
  })
})

describe('when finding the publication of an entity', () => {
  let getWorldScenes: jest.Mock
  let findPublication: Awaited<ReturnType<typeof createPartialDeploymentsComponent>>['findPublication']

  beforeEach(async () => {
    getWorldScenes = jest.fn()
    ;({ findPublication } = await createPartialDeploymentsComponent({
      config: { getNumber: jest.fn().mockResolvedValue(undefined) },
      worldsManager: { getWorldScenes }
    } as unknown as Components))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the entity is published', () => {
    let result: Awaited<ReturnType<typeof findPublication>>

    beforeEach(async () => {
      getWorldScenes.mockResolvedValueOnce({
        scenes: [
          {
            entityId: 'entity',
            worldName: 'world.dcl.eth',
            parcels: ['0,0'],
            entity: { metadata: { worldConfiguration: { name: 'World.dcl.eth' }, scene: { parcels: ['0,0'] } } },
            createdAt: new Date(789)
          }
        ],
        total: 1
      })
      result = await findPublication('https://worlds.example', 'entity')
    })

    it('should look it up among deployed scenes by entity id alone', () => {
      expect(getWorldScenes).toHaveBeenCalledWith({ entityId: 'entity' }, { limit: 1 })
    })

    it('should answer with a completed result carrying the publication timestamp', () => {
      expect(result).toEqual({
        complete: true,
        creationTimestamp: 789,
        result: { message: expect.stringContaining('World.dcl.eth') }
      })
    })
  })

  describe('and the entity is not published', () => {
    let result: Awaited<ReturnType<typeof findPublication>>

    beforeEach(async () => {
      getWorldScenes.mockResolvedValueOnce({ scenes: [], total: 0 })
      result = await findPublication('https://worlds.example', 'entity')
    })

    it('should return nothing', () => {
      expect(result).toBeUndefined()
    })
  })
})
