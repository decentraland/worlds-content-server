import { AuthLinkType, Entity, EntityType } from '@dcl/schemas'
import { InvalidRequestError } from '@dcl/http-commons'
import { FileInfo, IContentStorageComponent } from '@dcl/catalyst-storage'
import { createSceneDeploymentsComponent, DeployResult, getContentFileInfos } from '../../src/logic/scene-deployments'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { createDeploymentProcessingMock, createStageRecorder, StageRecorder } from '../mocks/deployment-processing-mock'
import {
  DeploymentFile,
  DeploymentProcessingStage,
  DeploymentToValidate,
  MissingSceneReplacementAuthorizationError,
  DeploymentUniqueViolationError
} from '../../src/types'
import {
  DEFAULT_CONTENT_FILE_INFO_CONCURRENCY,
  DeploymentProcessingTimeoutError
} from '../../src/logic/deployment-processing'
import { StageDeploymentInput } from '../../src/logic/scene-deployments/types'
import { PartialUploadExpiredError } from '../../src/logic/partial-upload-admission'

type Components = Parameters<typeof createSceneDeploymentsComponent>[0]

describe('when staging a partial deployment', () => {
  let components: Components
  let input: StageDeploymentInput
  let fileInfo: jest.Mock
  let getProgress: jest.Mock
  let getPending: jest.Mock
  let getPublishedContent: jest.Mock
  let recordStored: jest.Mock
  let storeStream: jest.Mock
  let validateStaging: jest.Mock
  let validate: jest.Mock
  let deployEntity: jest.Mock
  let admitBatch: jest.Mock
  let getDeployedScene: jest.Mock
  let getCompleted: jest.Mock
  let deleteByEntityId: jest.Mock
  let increment: jest.Mock
  let observe: jest.Mock
  let stage: Awaited<ReturnType<typeof createSceneDeploymentsComponent>>['stage']
  let prevalidate: Awaited<ReturnType<typeof createSceneDeploymentsComponent>>['prevalidate']

  beforeEach(async () => {
    input = {
      baseUrl: 'https://worlds.example',
      entityFile: Buffer.from('{}'),
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
    getPublishedContent = jest.fn().mockResolvedValue(new Set())
    recordStored = jest.fn().mockResolvedValue(2)
    storeStream = jest.fn().mockResolvedValue(undefined)
    validateStaging = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })
    validate = jest.fn(async (deployment: DeploymentToValidate) => {
      deployment.sceneReplacementAuthorization = { mode: 'unrestricted-owner' }
      return { ok: () => true, errors: [] }
    })
    deployEntity = jest.fn().mockResolvedValue({ message: 'deployed', creationTimestamp: 123 })
    admitBatch = jest.fn().mockResolvedValue({ createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) })
    getDeployedScene = jest.fn().mockResolvedValue(undefined)
    getCompleted = jest.fn().mockResolvedValue({ creationTimestamp: 123 })
    deleteByEntityId = jest.fn().mockResolvedValue(undefined)
    increment = jest.fn()
    observe = jest.fn()
    components = {
      coordinates: createCoordinatesComponent(),
      deploymentProcessing: createDeploymentProcessingMock(),
      entityDeployer: { deployEntity },
      limitsManager: { getMaxAllowedSizeInBytesFor: jest.fn().mockResolvedValue(10000n) },
      logs: { getLogger: jest.fn() },
      metrics: { increment, observe },
      partialUploadAdmission: {
        getByEntityId: getPending,
        admitBatch,
        recordStored,
        getCompleted
      },
      pendingScenesRepository: {
        getPublishedContent,
        getProgress,
        deleteByEntityId
      },
      storage: { fileInfo, storeStream },
      validator: { validateStaging, validate },
      worldsManager: { hasNewerDeployedScene: jest.fn().mockResolvedValue(false), getDeployedScene }
    } as unknown as Components
    ;({ stage, prevalidate } = await createSceneDeploymentsComponent(components))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and validation rejects the manifest', () => {
    let caughtError: unknown

    beforeEach(async () => {
      validateStaging.mockResolvedValueOnce({ ok: () => false, errors: ['invalid manifest'] })
      caughtError = await stage(input).catch((error: unknown) => error)
    })

    it('should reject it as an invalid request', () => {
      expect(caughtError).toBeInstanceOf(InvalidRequestError)
    })

    it('should report the validation errors', () => {
      expect((caughtError as Error).message).toBe('Deployment failed: invalid manifest')
    })

    it('should not look up storage or reserve bytes', () => {
      expect({ metadata: fileInfo.mock.calls.length, reservations: admitBatch.mock.calls.length }).toEqual({
        metadata: 0,
        reservations: 0
      })
    })
  })

  describe('and the entity has no content list', () => {
    let error: unknown

    beforeEach(async () => {
      input.entity = { ...input.entity, content: undefined }
      error = await stage(input).catch((e: unknown) => e)
    })

    it('should reject it as an invalid request before looking up storage or reserving bytes', () => {
      expect({ error, metadata: fileInfo.mock.calls.length, reservations: admitBatch.mock.calls.length }).toEqual({
        error: new InvalidRequestError('Deployment failed: the entity has no content list.'),
        metadata: 0,
        reservations: 0
      })
    })
  })

  describe('and the batch was validated before the content lock', () => {
    beforeEach(async () => {
      input.prevalidation = { sawPending: false }
      await stage(input)
    })

    it('should not validate it again', () => {
      expect(validateStaging).not.toHaveBeenCalled()
    })

    it('should still create the upload', () => {
      expect(admitBatch.mock.calls[0][0].upload.resumes).toBe(false)
    })

    it('should count the metadata checks of its content', () => {
      expect(increment).toHaveBeenCalledWith('partial_upload_metadata_checks', {}, 2)
    })
  })

  describe("and the signer's upload seen before the content lock is gone under it", () => {
    let caughtError: unknown

    beforeEach(async () => {
      input.prevalidation = { sawPending: true }
      caughtError = await stage(input).catch((error: unknown) => error)
    })

    it('should reject the batch as expired', () => {
      expect(caughtError).toBeInstanceOf(PartialUploadExpiredError)
    })

    it('should neither validate, look up storage nor create an upload', () => {
      expect({
        validations: validateStaging.mock.calls.length,
        metadata: fileInfo.mock.calls.length,
        upserts: admitBatch.mock.calls.length
      }).toEqual({ validations: 0, metadata: 0, upserts: 0 })
    })
  })

  describe("and the signer's upload seen before the content lock is still live", () => {
    beforeEach(async () => {
      input.prevalidation = { sawPending: true }
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(new Map())
      await stage(input)
    })

    it('should resume it', () => {
      expect(admitBatch.mock.calls[0][0].upload.resumes).toBe(true)
    })
  })

  describe('and the batch is validated ahead of staging', () => {
    describe('and the signer has a live upload of the entity', () => {
      let createdAt: Date
      let result: Awaited<ReturnType<typeof prevalidate>>

      beforeEach(async () => {
        createdAt = new Date(5_000)
        result = await prevalidate(input, {
          entityId: 'entity',
          worldName: 'world.dcl.eth',
          parcels: ['0,0'],
          deployer: 'deployer',
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 86_400_000),
          updatedAt: createdAt,
          initialized: true
        })
      })

      it('should skip the permission check and report the upload as seen', () => {
        expect({ options: validateStaging.mock.calls[0][1], result }).toEqual({
          options: { skipPermissionCheck: true },
          result: { sawPending: true }
        })
      })

      it('should validate freshness against the upload admission', () => {
        expect(validateStaging.mock.calls[0][0].pendingCreatedAt).toBe(createdAt)
      })
    })

    describe('and another signer has a live upload of the entity', () => {
      let result: Awaited<ReturnType<typeof prevalidate>>

      beforeEach(async () => {
        result = await prevalidate(input, {
          entityId: 'entity',
          worldName: 'world.dcl.eth',
          parcels: ['0,0'],
          deployer: 'other',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
          updatedAt: new Date(),
          initialized: true
        })
      })

      it('should check permission and not report the upload as seen', () => {
        expect({ options: validateStaging.mock.calls[0][1], result }).toEqual({
          options: { skipPermissionCheck: false },
          result: { sawPending: false }
        })
      })
    })

    describe('and there is no live upload of the entity', () => {
      let result: Awaited<ReturnType<typeof prevalidate>>

      beforeEach(async () => {
        result = await prevalidate(input, undefined)
      })

      it('should check permission against the request arrival', () => {
        expect({
          options: validateStaging.mock.calls[0][1],
          anchor: validateStaging.mock.calls[0][0].pendingCreatedAt,
          result
        }).toEqual({
          options: { skipPermissionCheck: false },
          anchor: new Date(input.requestArrivedAt),
          result: { sawPending: false }
        })
      })
    })

    describe('and validation rejects the batch', () => {
      let caughtError: unknown

      beforeEach(async () => {
        validateStaging.mockResolvedValueOnce({ ok: () => false, errors: ['no permission'] })
        caughtError = await prevalidate(input, undefined).catch((error: unknown) => error)
      })

      it('should reject it as an invalid request', () => {
        expect(caughtError).toEqual(new InvalidRequestError('Deployment failed: no permission'))
      })
    })
  })

  describe('and the batch admits a new upload', () => {
    beforeEach(async () => {
      await stage(input)
    })

    it('should create the upload at the instant its freshness was validated', () => {
      expect(admitBatch.mock.calls[0][0].upload.admittedAt).toBe(validateStaging.mock.calls[0][0].pendingCreatedAt)
    })

    it('should admit it at the request arrival', () => {
      expect(admitBatch.mock.calls[0][0].upload.admittedAt).toEqual(new Date(input.requestArrivedAt))
    })

    it('should let the upload be created', () => {
      expect(admitBatch.mock.calls[0][0].upload.resumes).toBe(false)
    })

    it('should count it as a started upload', () => {
      expect(increment).toHaveBeenCalledWith('partial_uploads_started')
    })
  })

  describe('and the upload expires before the batch stores its files', () => {
    let caughtError: unknown

    beforeEach(async () => {
      admitBatch.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 86_400_000), expiresAt: new Date() })
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
      expect(admitBatch.mock.calls[0][0].upload.resumes).toBe(true)
    })
  })

  describe('and a resumed batch is still incomplete', () => {
    let result: Awaited<ReturnType<typeof stage>>

    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(new Map())
      result = await stage(input)
    })

    it('should report the missing hashes', () => {
      expect(result).toEqual({ complete: false, missing: ['b'] })
    })

    it('should not query storage metadata', () => {
      expect(fileInfo).not.toHaveBeenCalled()
    })
  })

  describe('and the staging budget is exhausted', () => {
    let caughtError: unknown

    beforeEach(async () => {
      admitBatch.mockRejectedValueOnce(new Error('budget exceeded'))
      caughtError = await stage(input).catch((error: unknown) => error)
    })

    it('should reject with the admission error', () => {
      expect(caughtError).toEqual(new Error('budget exceeded'))
    })

    it('should not write to storage', () => {
      expect(storeStream).not.toHaveBeenCalled()
    })
  })

  describe('and a resumed batch completes the manifest', () => {
    beforeEach(() => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(new Map([['b', 500]])).mockResolvedValueOnce(
        new Map([
          ['a', 300],
          ['b', 500]
        ])
      )
      input.signal = new AbortController().signal
      input.deadlineAt = Date.now() + 60000
    })

    describe('and it is staged', () => {
      let result: Awaited<ReturnType<typeof stage>>

      beforeEach(async () => {
        result = await stage(input)
      })

      it('should answer with the completion timestamp', () => {
        expect(result).toEqual({
          complete: true,
          result: { message: 'deployed', creationTimestamp: 123 },
          creationTimestamp: 123
        })
      })

      it('should publish the total size from the uploaded file and the stored progress under the request signal and deadline', () => {
        const [, , , , , , size, options] = deployEntity.mock.calls[0]
        expect([size, options.signal, options.deadlineAt]).toEqual([800, input.signal, input.deadlineAt])
      })

      it('should validate the content sizes recorded in the stored progress', () => {
        expect(validate.mock.calls[0][0].contentFileInfos).toEqual(
          new Map([
            ['a', { size: 300 }],
            ['b', { size: 500 }]
          ])
        )
      })

      it('should not look up storage metadata', () => {
        expect({
          metadata: fileInfo.mock.calls.length,
          checks: increment.mock.calls.filter(([name]) => name === 'partial_upload_metadata_checks')
        }).toEqual({ metadata: 0, checks: [] })
      })

      it('should pass the request signal into storage writes', () => {
        expect(storeStream.mock.calls[0][2]).toBe(input.signal)
      })
    })

    describe('and the upload is published', () => {
      let createdAt: Date

      beforeEach(async () => {
        createdAt = new Date(Date.now() - 5_000)
        admitBatch.mockResolvedValueOnce({ createdAt, expiresAt: new Date(createdAt.getTime() + 86_400_000) })
        await stage(input)
      })

      it('should mark the publication as a partial finalization that expires with the upload', () => {
        expect(deployEntity.mock.calls[0][7].completesPartialUpload).toEqual({
          expiresAt: createdAt.getTime() + 86_400_000
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
  })

  describe('and the request is already cancelled', () => {
    let caughtError: unknown

    beforeEach(async () => {
      input.signal = AbortSignal.abort(new Error('cancelled'))
      caughtError = await stage(input).catch((error: unknown) => error)
    })

    it('should reject with the cancellation reason', () => {
      expect(caughtError).toEqual(new Error('cancelled'))
    })

    it('should not look up pending state', () => {
      expect(getPending).not.toHaveBeenCalled()
    })
  })

  describe('and there is no live upload while a newer scene is deployed on its parcels', () => {
    let caughtError: unknown

    beforeEach(async () => {
      input.entity.metadata.worldConfiguration.name = 'World.dcl.eth'
      components.worldsManager.hasNewerDeployedScene = jest.fn().mockResolvedValueOnce(true)
      caughtError = await stage(input).catch((error: unknown) => error)
    })

    it('should reject it as an invalid request', () => {
      expect(caughtError).toBeInstanceOf(InvalidRequestError)
    })

    it('should report that a newer scene is deployed', () => {
      expect((caughtError as Error).message).toBe(
        'Deployment failed: a newer scene is already deployed on one or more of these parcels.'
      )
    })

    it('should check the lowercased world name and the entity', () => {
      expect(components.worldsManager.hasNewerDeployedScene).toHaveBeenCalledWith('world.dcl.eth', input.entity)
    })

    it('should neither look up storage, admit the batch nor store its files', () => {
      expect({
        metadata: fileInfo.mock.calls.length,
        admissions: admitBatch.mock.calls.length,
        writes: storeStream.mock.calls.length
      }).toEqual({ metadata: 0, admissions: 0, writes: 0 })
    })
  })

  describe('and the batch resumes a live upload', () => {
    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(new Map())
      await stage(input)
    })

    it('should not check for a newer deployed scene', () => {
      expect(components.worldsManager.hasNewerDeployedScene).not.toHaveBeenCalled()
    })
  })
  describe('and a resume batch omits the manifest', () => {
    let validatedFiles: string[]

    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(new Map())
      input.manifest = { size: 40, getStream: jest.fn(), getHash: jest.fn(), asBuffer: jest.fn() }
      await stage(input)
      validatedFiles = Array.from((validateStaging.mock.calls[0][0] as DeploymentToValidate).files.keys())
    })

    it('should validate the manifest but only charge and store the uploaded files', () => {
      expect({
        validatedFiles,
        incomingBytes: admitBatch.mock.calls[0][0].incomingBytes,
        stored: storeStream.mock.calls.map(([hash]) => hash)
      }).toEqual({ validatedFiles: ['a', 'entity'], incomingBytes: 300, stored: ['a'] })
    })

    it('should charge the uploaded file it stores', () => {
      expect(admitBatch.mock.calls[0][0].receipts).toEqual([{ hash: 'a', size: 300, stored: false, charged: true }])
    })
  })

  describe('and the first batch re-sends content published content already references', () => {
    beforeEach(async () => {
      fileInfo.mockImplementation(async (hash) => (hash === 'a' ? { size: 300 } : undefined))
      getPublishedContent.mockResolvedValueOnce(new Set(['a']))
      await stage(input)
    })

    it('should ask only about the content found in storage', () => {
      expect(getPublishedContent.mock.calls).toEqual([[['a'], undefined]])
    })

    it('should record it as stored without charging, storing or recording a write for it', () => {
      expect({
        receipts: admitBatch.mock.calls[0][0].receipts,
        stored: storeStream.mock.calls.length,
        recorded: recordStored.mock.calls[0][1]
      }).toEqual({ receipts: [{ hash: 'a', size: 300, stored: true, charged: false }], stored: 0, recorded: [] })
    })

    it('should still count its bytes against the byte rate', () => {
      expect(admitBatch.mock.calls[0][0].incomingBytes).toBe(300)
    })
  })

  describe('and the first batch re-sends content in storage only for other pending uploads', () => {
    beforeEach(async () => {
      fileInfo.mockImplementation(async (hash) => (hash === 'a' ? { size: 300 } : undefined))
      await stage(input)
    })

    it('should charge it without storing or recording a write for it', () => {
      expect({
        receipts: admitBatch.mock.calls[0][0].receipts,
        stored: storeStream.mock.calls.length,
        recorded: recordStored.mock.calls[0][1]
      }).toEqual({ receipts: [{ hash: 'a', size: 300, stored: true, charged: true }], stored: 0, recorded: [] })
    })
  })

  describe('and a resumed batch re-sends a file an earlier batch stored', () => {
    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(new Map([['a', 300]]))
      await stage(input)
    })

    it('should neither charge nor store it again', () => {
      expect({ receipts: admitBatch.mock.calls[0][0].receipts, stored: storeStream.mock.calls.length }).toEqual({
        receipts: [],
        stored: 0
      })
    })
  })

  describe('and a new upload has published content already in storage', () => {
    beforeEach(async () => {
      fileInfo.mockImplementation(async (hash) => (hash === 'b' ? { size: 500 } : undefined))
      getPublishedContent.mockResolvedValueOnce(new Set(['b']))
      await stage(input)
    })

    it('should not look up stored progress for an upload that has none', () => {
      expect(getProgress.mock.calls).toEqual([['entity', undefined]])
    })

    it('should charge the received file but not the stored content', () => {
      expect(admitBatch.mock.calls[0][0].receipts).toEqual([
        { hash: 'b', size: 500, stored: true, charged: false },
        { hash: 'a', size: 300, stored: false, charged: true }
      ])
    })
  })

  describe('and publication collides with a concurrent publication of the same entity', () => {
    let result: Awaited<ReturnType<typeof stage>>

    beforeEach(async () => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(new Map([['b', 500]])).mockResolvedValueOnce(
        new Map([
          ['a', 300],
          ['b', 500]
        ])
      )
      deployEntity.mockRejectedValueOnce(
        new DeploymentUniqueViolationError('entity', Object.assign(new Error('duplicate key'), { code: '23505' }))
      )
      getDeployedScene.mockResolvedValueOnce({
        entityId: 'entity',
        worldName: 'world.dcl.eth',
        parcels: ['0,0'],
        entity: input.entity,
        createdAt: new Date(456)
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
      getProgress.mockResolvedValueOnce(new Map([['b', 500]])).mockResolvedValueOnce(
        new Map([
          ['a', 300],
          ['b', 500]
        ])
      )
      deployEntity.mockRejectedValueOnce(
        new DeploymentUniqueViolationError('entity', Object.assign(new Error('duplicate key'), { code: '23505' }))
      )
      error = await stage(input).catch((e) => e)
    })

    it('should propagate the original collision', () => {
      expect(error).toMatchObject({ message: 'duplicate key', code: '23505' })
    })
  })

  describe('and its processing stages are tracked', () => {
    let recorder: StageRecorder
    let stagesByCall: Record<string, DeploymentProcessingStage[][]>

    function recordStages(name: string, mock: jest.Mock): void {
      const implementation = mock.getMockImplementation()
      mock.mockImplementation((...args: unknown[]) => {
        ;(stagesByCall[name] ??= []).push(recorder.openStages())
        return implementation?.(...args)
      })
    }

    // Called after a scenario sets its mocks: one-shot values would bypass the recording wrapper.
    async function stageRecordingStages(): Promise<void> {
      recordStages('getByEntityId', getPending)
      recordStages('hasNewerDeployedScene', components.worldsManager.hasNewerDeployedScene as jest.Mock)
      recordStages('getMaxAllowedSizeInBytesFor', components.limitsManager.getMaxAllowedSizeInBytesFor as jest.Mock)
      recordStages('getPublishedContent', getPublishedContent)
      recordStages('admitBatch', admitBatch)
      recordStages('recordStored', recordStored)
      recordStages('getProgress', getProgress)
      ;({ stage } = await createSceneDeploymentsComponent({
        ...components,
        deploymentProcessing: createDeploymentProcessingMock({ trackStage: recorder.trackStage })
      }))
      await stage(input)
    }

    beforeEach(() => {
      recorder = createStageRecorder()
      stagesByCall = {}
    })

    describe('and the batch admits a new upload', () => {
      beforeEach(async () => {
        await stageRecordingStages()
      })

      it('should read the pending upload inside the lookup stage', () => {
        expect(stagesByCall.getByEntityId).toEqual([['lookup']])
      })

      it('should check for a newer scene inside the lookup stage', () => {
        expect(stagesByCall.hasNewerDeployedScene).toEqual([['lookup']])
      })

      it('should look up the size limit inside the limits stage', () => {
        expect(stagesByCall.getMaxAllowedSizeInBytesFor).toEqual([['limits']])
      })

      it('should read published content inside the admission stage', () => {
        expect(stagesByCall.getPublishedContent).toEqual([['admission']])
      })

      it('should admit the batch inside the admission stage', () => {
        expect(stagesByCall.admitBatch).toEqual([['admission']])
      })

      it('should record the stored files inside the admission stage', () => {
        expect(stagesByCall.recordStored).toEqual([['admission']])
      })

      it('should read the progress inside the admission stage', () => {
        expect(stagesByCall.getProgress).toEqual([['admission']])
      })

      it('should count each bookkeeping call as one item', () => {
        expect(
          recorder.trackStage.mock.calls
            .filter(([stage]) => ['lookup', 'limits', 'admission'].includes(stage))
            .map(([, items]) => items)
        ).toEqual([1, 1, 1, 1, 1, 1, 1])
      })
    })

    describe('and a resumed batch completes the upload', () => {
      beforeEach(async () => {
        let progressReads = 0
        getPending.mockResolvedValue({ createdAt: new Date(), deployer: 'deployer', initialized: true })
        getProgress.mockImplementation(async () =>
          progressReads++ === 0
            ? new Map([['b', 500]])
            : new Map([
                ['a', 300],
                ['b', 500]
              ])
        )
        await stageRecordingStages()
      })

      it('should read the progress before and after storing inside the admission stage', () => {
        expect(stagesByCall.getProgress).toEqual([['admission'], ['admission']])
      })

      it('should not open a metadata stage', () => {
        expect(recorder.trackStage.mock.calls.map(([stage]) => stage)).not.toContain('metadata')
      })
    })
  })
})

describe('when finding the publication of an entity', () => {
  let getDeployedScene: jest.Mock
  let findPublication: Awaited<ReturnType<typeof createSceneDeploymentsComponent>>['findPublication']

  beforeEach(async () => {
    getDeployedScene = jest.fn()
    ;({ findPublication } = await createSceneDeploymentsComponent({
      logs: { getLogger: jest.fn() },
      worldsManager: { getDeployedScene }
    } as unknown as Components))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the entity is published', () => {
    let result: Awaited<ReturnType<typeof findPublication>>

    beforeEach(async () => {
      getDeployedScene.mockResolvedValueOnce({
        entityId: 'entity',
        worldName: 'world.dcl.eth',
        parcels: ['0,0'],
        entity: { metadata: { worldConfiguration: { name: 'World.dcl.eth' }, scene: { parcels: ['0,0'] } } },
        createdAt: new Date(789)
      })
      result = await findPublication('https://worlds.example', 'entity')
    })

    it('should look it up among deployed scenes by entity id alone', () => {
      expect(getDeployedScene).toHaveBeenCalledWith('entity', undefined)
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
      getDeployedScene.mockResolvedValueOnce(undefined)
      result = await findPublication('https://worlds.example', 'entity')
    })

    it('should return nothing', () => {
      expect(result).toBeUndefined()
    })
  })
})

describe('when prevalidating a single-request deployment', () => {
  let validateBeforeStorage: jest.Mock
  let entity: Entity
  let files: Map<string, DeploymentFile>
  let signal: AbortSignal
  let prevalidateDeployment: Awaited<ReturnType<typeof createSceneDeploymentsComponent>>['prevalidateDeployment']

  beforeEach(async () => {
    validateBeforeStorage = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })
    entity = { version: 'v3', id: 'entity', type: EntityType.SCENE, timestamp: 1, pointers: ['0,0'], content: [] }
    files = new Map()
    signal = new AbortController().signal
    ;({ prevalidateDeployment } = await createSceneDeploymentsComponent({
      logs: { getLogger: jest.fn() },
      validator: { validateBeforeStorage }
    } as unknown as Components))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and it passes the pre-storage validation', () => {
    let deployment: DeploymentToValidate

    beforeEach(async () => {
      deployment = await prevalidateDeployment({ entity, authChain: [], files, signal })
    })

    it('should return the validated deployment, with nothing known to be in storage yet', () => {
      expect({ deployment, validated: validateBeforeStorage.mock.calls[0][0] }).toEqual({
        deployment: { entity, files, authChain: [], contentHashesInStorage: new Map(), signal },
        validated: deployment
      })
    })
  })

  describe('and it fails the pre-storage validation', () => {
    let error: unknown

    beforeEach(async () => {
      validateBeforeStorage.mockResolvedValueOnce({ ok: () => false, errors: ['no permission', 'too big'] })
      error = await prevalidateDeployment({ entity, authChain: [], files, signal }).catch((e: unknown) => e)
    })

    it('should reject it as an invalid request with every validation error', () => {
      expect(error).toEqual(new InvalidRequestError('Deployment failed: no permission, too big'))
    })
  })
})

describe('when deploying a single-request deployment', () => {
  let deployment: DeploymentToValidate
  let fileInfo: jest.Mock
  let validateAfterStorage: jest.Mock
  let deployEntity: jest.Mock
  let getDeployedScene: jest.Mock
  let info: jest.Mock
  let increment: jest.Mock
  let signal: AbortSignal
  let deploy: Awaited<ReturnType<typeof createSceneDeploymentsComponent>>['deploy']

  beforeEach(async () => {
    deployment = {
      entity: {
        version: 'v3',
        id: 'entity',
        type: EntityType.SCENE,
        timestamp: 1,
        pointers: ['0,0'],
        content: [
          { file: 'a.bin', hash: 'a' },
          { file: 'b.bin', hash: 'b' },
          { file: 'b-copy.bin', hash: 'b' }
        ],
        metadata: { worldConfiguration: { name: 'World.dcl.eth' }, scene: { base: '0,0', parcels: ['0,0'] } }
      },
      files: new Map([['a', { size: 5, getStream: jest.fn(), getHash: jest.fn(), asBuffer: jest.fn() }]]),
      authChain: [{ type: AuthLinkType.SIGNER, payload: 'deployer', signature: '' }],
      contentHashesInStorage: new Map(),
      signal: new AbortController().signal,
      sceneReplacementAuthorization: { mode: 'unrestricted-owner' }
    }
    signal = new AbortController().signal
    fileInfo = jest.fn(async (hash: string) => (hash === 'b' ? { size: 7, contentSize: 7, encoding: null } : undefined))
    validateAfterStorage = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })
    deployEntity = jest.fn().mockResolvedValue({ message: 'deployed', creationTimestamp: 123 })
    getDeployedScene = jest.fn().mockResolvedValue(undefined)
    info = jest.fn()
    increment = jest.fn()
    ;({ deploy } = await createSceneDeploymentsComponent({
      deploymentProcessing: createDeploymentProcessingMock(),
      entityDeployer: { deployEntity },
      logs: { getLogger: jest.fn().mockReturnValue({ info }) },
      metrics: { increment },
      storage: { fileInfo },
      validator: { validateAfterStorage },
      worldsManager: { getDeployedScene }
    } as unknown as Components))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
  })

  describe('and it is published', () => {
    let result: DeployResult

    beforeEach(async () => {
      result = await deploy({
        baseUrl: 'https://worlds.example',
        entityFile: Buffer.from('{}'),
        deployment,
        signal,
        deadlineAt: 99
      })
    })

    it('should look up the metadata of each unique content hash once', () => {
      expect(fileInfo.mock.calls).toEqual([['a'], ['b']])
    })

    it('should not count it as a partial upload', () => {
      expect(increment).not.toHaveBeenCalled()
    })

    it('should validate the content against its storage metadata', () => {
      expect(validateAfterStorage.mock.calls[0][0]).toEqual({
        ...deployment,
        contentHashesInStorage: new Map([
          ['a', false],
          ['b', true]
        ]),
        contentFileInfos: new Map([
          ['a', undefined],
          ['b', { size: 7, contentSize: 7, encoding: null }]
        ]),
        signal
      })
    })

    it("should validate and publish it under the request's signal", () => {
      expect({
        validated: validateAfterStorage.mock.calls[0][0].signal === signal,
        published: deployEntity.mock.calls[0][7].signal === signal
      }).toEqual({ validated: true, published: true })
    })

    it('should publish it with its uploaded and stored size and the replacement authorization', () => {
      expect(deployEntity.mock.calls[0]).toEqual([
        'https://worlds.example',
        deployment.entity,
        new Map([
          ['a', false],
          ['b', true]
        ]),
        deployment.files,
        Buffer.from('{}'),
        deployment.authChain,
        12,
        { signal, deadlineAt: 99, sceneReplacementAuthorization: { mode: 'unrestricted-owner' } }
      ])
    })

    it("should answer with the deployer's result", () => {
      expect(result).toEqual({ creationTimestamp: 123, message: 'deployed' })
    })
  })

  describe('and the deployer reports no creation timestamp', () => {
    let result: DeployResult

    beforeEach(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(4242)
      deployEntity.mockResolvedValueOnce({ message: 'deployed' })
      result = await deploy({
        baseUrl: 'https://worlds.example',
        entityFile: Buffer.from('{}'),
        deployment,
        signal,
        deadlineAt: 99
      })
    })

    it('should answer with the current time', () => {
      expect(result).toEqual({ creationTimestamp: 4242, message: 'deployed' })
    })
  })

  describe('and the after-storage validation rejects it', () => {
    let error: unknown

    beforeEach(async () => {
      validateAfterStorage.mockResolvedValueOnce({ ok: () => false, errors: ['hash mismatch'] })
      error = await deploy({
        baseUrl: 'https://worlds.example',
        entityFile: Buffer.from('{}'),
        deployment,
        signal,
        deadlineAt: 99
      }).catch((e: unknown) => e)
    })

    it('should reject it as an invalid request without publishing it', () => {
      expect({ error, published: deployEntity.mock.calls.length }).toEqual({
        error: new InvalidRequestError('Deployment failed: hash mismatch'),
        published: 0
      })
    })
  })

  describe('and the entity has no content list', () => {
    let error: unknown

    beforeEach(async () => {
      deployment.entity = { ...deployment.entity, content: undefined }
      error = await deploy({
        baseUrl: 'https://worlds.example',
        entityFile: Buffer.from('{}'),
        deployment,
        signal,
        deadlineAt: 99
      }).catch((e: unknown) => e)
    })

    it('should reject it as an invalid request without looking up storage or publishing it', () => {
      expect({ error, metadata: fileInfo.mock.calls.length, published: deployEntity.mock.calls.length }).toEqual({
        error: new InvalidRequestError('Deployment failed: the entity has no content list.'),
        metadata: 0,
        published: 0
      })
    })
  })

  describe('and the scene has no replacement authorization', () => {
    let error: unknown

    beforeEach(async () => {
      deployment.sceneReplacementAuthorization = undefined
      error = await deploy({
        baseUrl: 'https://worlds.example',
        entityFile: Buffer.from('{}'),
        deployment,
        signal,
        deadlineAt: 99
      }).catch((e: unknown) => e)
    })

    it('should reject it without publishing it', () => {
      expect({ error, published: deployEntity.mock.calls.length }).toEqual({
        error: new MissingSceneReplacementAuthorizationError('entity'),
        published: 0
      })
    })
  })

  describe('and the publication collides with an already deployed entity', () => {
    let collision: Error

    beforeEach(() => {
      collision = Object.assign(new Error('duplicate key'), { code: '23505' })
      deployEntity.mockRejectedValueOnce(new DeploymentUniqueViolationError('entity', collision))
    })

    describe('and the entity is live in its world', () => {
      let result: DeployResult

      beforeEach(async () => {
        getDeployedScene.mockResolvedValueOnce({ entityId: 'entity', createdAt: new Date(321) })
        result = await deploy({
          baseUrl: 'https://worlds.example',
          entityFile: Buffer.from('{}'),
          deployment,
          signal,
          deadlineAt: 99
        })
      })

      it('should verify it among the deployed scenes of its world', () => {
        expect(getDeployedScene.mock.calls).toEqual([['entity', 'world.dcl.eth']])
      })

      it("should answer with the live publication's timestamp and this deployment's message", () => {
        expect(result).toEqual({
          creationTimestamp: 321,
          message: expect.stringContaining('Your scene was deployed to World "World.dcl.eth" at parcels: 0,0!')
        })
      })

      it('should log the idempotent success', () => {
        expect(info.mock.calls).toEqual([
          [
            'Deployment finalized concurrently; returning idempotent success',
            { entityId: 'entity', worldName: 'world.dcl.eth' }
          ]
        ])
      })
    })

    describe('and the entity is not deployed', () => {
      let error: unknown

      beforeEach(async () => {
        error = await deploy({
          baseUrl: 'https://worlds.example',
          entityFile: Buffer.from('{}'),
          deployment,
          signal,
          deadlineAt: 99
        }).catch((e: unknown) => e)
      })

      it('should propagate the original database error', () => {
        expect(error).toBe(collision)
      })
    })

    describe('and the publication lookup fails', () => {
      let error: unknown

      beforeEach(async () => {
        getDeployedScene.mockRejectedValueOnce(new Error('database unavailable'))
        error = await deploy({
          baseUrl: 'https://worlds.example',
          entityFile: Buffer.from('{}'),
          deployment,
          signal,
          deadlineAt: 99
        }).catch((e: unknown) => e)
      })

      it('should propagate the original database error', () => {
        expect(error).toBe(collision)
      })
    })

    describe('and the entity has no world name', () => {
      let error: unknown

      beforeEach(async () => {
        deployment.entity.metadata = { scene: { base: '0,0', parcels: ['0,0'] } }
        error = await deploy({
          baseUrl: 'https://worlds.example',
          entityFile: Buffer.from('{}'),
          deployment,
          signal,
          deadlineAt: 99
        }).catch((e: unknown) => e)
      })

      it('should propagate the original database error without looking it up', () => {
        expect({ error, lookups: getDeployedScene.mock.calls.length }).toEqual({ error: collision, lookups: 0 })
      })
    })
  })

  describe('and the publication fails for another reason', () => {
    let failure: Error
    let error: unknown

    beforeEach(async () => {
      failure = new Error('storage unavailable')
      deployEntity.mockRejectedValueOnce(failure)
      error = await deploy({
        baseUrl: 'https://worlds.example',
        entityFile: Buffer.from('{}'),
        deployment,
        signal,
        deadlineAt: 99
      }).catch((e: unknown) => e)
    })

    it('should propagate it without looking up the publication', () => {
      expect({ error, lookups: getDeployedScene.mock.calls.length }).toEqual({ error: failure, lookups: 0 })
    })
  })
})

describe('getContentFileInfos', () => {
  describe('when the deployment references more hashes than the metadata concurrency limit', () => {
    let storage: Pick<IContentStorageComponent, 'fileInfo'>
    let fileInfo: jest.Mock
    let hashes: string[]
    let fileInfos: Map<string, FileInfo | undefined>
    let activeChecks: number
    let maximumActiveChecks: number

    beforeEach(async () => {
      hashes = Array.from({ length: DEFAULT_CONTENT_FILE_INFO_CONCURRENCY * 2 + 2 }, (_, index) => `hash-${index}`)
      activeChecks = 0
      maximumActiveChecks = 0
      fileInfo = jest.fn(async () => {
        activeChecks++
        maximumActiveChecks = Math.max(maximumActiveChecks, activeChecks)
        await new Promise<void>((resolve) => setImmediate(resolve))
        activeChecks--
        return { encoding: null, size: 1, contentSize: 1 }
      })
      storage = { fileInfo }

      fileInfos = await getContentFileInfos(storage, hashes)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should query every hash with bounded concurrency and combine every result', () => {
      expect({
        calls: fileInfo.mock.calls.length,
        maximumActiveChecks,
        results: fileInfos.size
      }).toEqual({
        calls: hashes.length,
        maximumActiveChecks: DEFAULT_CONTENT_FILE_INFO_CONCURRENCY,
        results: hashes.length
      })
    })
  })

  describe('when duplicate hashes are provided', () => {
    let fileInfo: jest.Mock
    let fileInfos: Map<string, FileInfo | undefined>

    beforeEach(async () => {
      fileInfo = jest.fn().mockResolvedValue(undefined)
      fileInfos = await getContentFileInfos({ fileInfo }, ['a', 'a', 'b'])
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should query each content hash only once', () => {
      expect({ requested: fileInfo.mock.calls.map(([hash]) => hash), results: Array.from(fileInfos.keys()) }).toEqual({
        requested: ['a', 'b'],
        results: ['a', 'b']
      })
    })
  })

  describe('when an active metadata request outlives the processing deadline', () => {
    let caughtError: unknown
    let fileInfo: jest.Mock

    beforeEach(async () => {
      const controller = new AbortController()
      fileInfo = jest.fn(async () => new Promise<never>(() => undefined))
      const result = getContentFileInfos({ fileInfo }, ['a', 'b'], 1, controller.signal)
      controller.abort(new DeploymentProcessingTimeoutError(10))
      caughtError = await result.catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject promptly and leave queued metadata requests unstarted', () => {
      expect({ caughtError, requests: fileInfo.mock.calls.length }).toEqual({
        caughtError: new DeploymentProcessingTimeoutError(10),
        requests: 1
      })
    })
  })
})
