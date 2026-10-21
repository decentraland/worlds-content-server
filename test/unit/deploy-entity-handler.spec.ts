import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { bufferToStream, FileInfo } from '@dcl/catalyst-storage'
import {
  deployEntity as deployEntityHandler,
  MAX_ENTITY_FILE_SIZE_IN_BYTES
} from '../../src/controllers/handlers/deploy-entity-handler'
import { InvalidRequestError } from '@dcl/http-commons'
import { createDeploymentProcessingMock, createStageRecorder, StageRecorder } from '../mocks/deployment-processing-mock'
import {
  DeploymentProcessingAbortedError,
  DeploymentProcessingTimeoutError
} from '../../src/logic/deployment-processing'
import { hashV1 } from '@dcl/hashing'
import { Authenticator } from '@dcl/crypto'
import {
  DeploymentProcessingStage,
  DeploymentToValidate,
  DeploymentUniqueViolationError,
  SceneReplacementConflictError
} from '../../src/types'
import { PartialUploadQuotaExceededError, PartialUploadTooLargeError } from '../../src/logic/partial-upload-admission'
import { createSceneDeploymentsComponent } from '../../src/logic/scene-deployments'

type HandlerContext = Parameters<typeof deployEntityHandler>[0]
type SceneDeploymentsComponents = Parameters<typeof createSceneDeploymentsComponent>[0]
// The context also carries the components the real scene-deployments flow needs.
type DeployContext = HandlerContext & { components: HandlerContext['components'] & SceneDeploymentsComponents }

/** Runs the handler with the real scene-deployments flow built from the context's mocks; methods it mocks win. */
async function deployEntity(context: DeployContext): ReturnType<typeof deployEntityHandler> {
  const sceneDeployments = await createSceneDeploymentsComponent(context.components)
  context.components.sceneDeployments = { ...sceneDeployments, ...context.components.sceneDeployments }
  return deployEntityHandler(context)
}

describe('deployEntity', () => {
  const entityId = 'bafkreiahsvnr4x4rnskhkwfbnbplkbqhzb3xagdwpyfy44lgcndmhyizde'
  let tmpDir: string
  let fileCounter: number
  let defaultSignatureSpy: jest.SpyInstance

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'deploy-entity-test-'))
    fileCounter = 0
    // Every request is authenticated before the handler takes a lock; the fixture auth chain is
    // unsigned, so contexts that test later stages treat it as valid.
    defaultSignatureSpy = jest.spyOn(Authenticator, 'validateSignature').mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    defaultSignatureSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeField(...value: string[]) {
    return {
      fieldname: 'field',
      value,
      nameTruncated: false,
      valueTruncated: false,
      encoding: '7bit',
      mimeType: 'text/plain'
    }
  }

  // Uploaded files are streamed to temp files, so the handler reads them by path. Write the
  // content to a temp file and return the metadata the multipart parser would have produced.
  function makeFile(content: Buffer) {
    const filepath = path.join(tmpDir, `file-${fileCounter++}`)
    writeFileSync(filepath, content)
    return {
      fieldname: 'file',
      filename: 'file',
      encoding: '7bit',
      mimeType: 'application/octet-stream',
      filepath,
      size: content.length
    }
  }

  /**
   * Builds a minimal multipart context with a valid entityId field and a single-link auth chain,
   * so the handler reaches the entity-file handling instead of failing earlier on a missing auth chain.
   */
  function createContext(id: string, files: Record<string, ReturnType<typeof makeFile>>): DeployContext {
    return {
      components: {
        contentLocks: {
          withRead: async (operation: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) =>
            operation(signal)
        },
        deploymentProcessing: createDeploymentProcessingMock(),
        config: { getString: jest.fn().mockResolvedValue(undefined) },
        // Default no-op partial-upload admission; tests of partial requests that need a pending row override it.
        partialUploadAdmission: {
          getByEntityId: jest.fn().mockResolvedValue(undefined),
          getCompleted: jest.fn().mockResolvedValue(undefined)
        },
        sceneDeployments: {
          findPublication: jest.fn().mockResolvedValue(undefined),
          prevalidate: jest.fn().mockResolvedValue({ sawPending: false })
        },
        validator: { validateBeforeStorage: jest.fn().mockResolvedValue({ ok: () => true, errors: [] }) },
        metrics: { increment: jest.fn() },
        logs: {
          getLogger: jest.fn().mockReturnValue({ debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() })
        }
      },
      formData: {
        fields: {
          entityId: makeField(id),
          'authChain[0][payload]': makeField('0x0000000000000000000000000000000000000001'),
          'authChain[0][signature]': makeField(''),
          'authChain[0][type]': makeField('SIGNER')
        },
        files
      },
      request: { signal: new AbortController().signal },
      requestArrivedAt: Date.now(),
      url: new URL('https://request.example/entities')
    } as unknown as DeployContext
  }

  describe('when a request is deployed', () => {
    let context: DeployContext

    beforeEach(() => {
      context = createContext(entityId, {})
    })

    describe('and it is a regular deployment', () => {
      beforeEach(async () => {
        await deployEntity(context).catch(() => undefined)
      })

      it('should process it in the regular mode', () => {
        expect(context.components.deploymentProcessing.runInMode).toHaveBeenCalledWith('regular', expect.any(Function))
      })
    })

    describe('and it is a partial batch', () => {
      beforeEach(async () => {
        context.formData.fields.partial = makeField('true')
        await deployEntity(context).catch(() => undefined)
      })

      it('should process it in the partial mode', () => {
        expect(context.components.deploymentProcessing.runInMode).toHaveBeenCalledWith('partial', expect.any(Function))
      })
    })
  })

  describe('when the entity file referenced by entityId is missing from the request', () => {
    let context: DeployContext

    beforeEach(() => {
      context = createContext(entityId, {})
    })

    it('should reject with an InvalidRequestError instead of crashing', async () => {
      const error = await deployEntity(context).catch((e) => e)

      expect(error).toBeInstanceOf(InvalidRequestError)
      expect(error.message).toBe(`Entity file "${entityId}" is missing from the request.`)
    })
  })

  describe('when the entity file is not valid JSON', () => {
    let context: DeployContext

    beforeEach(() => {
      context = createContext(entityId, { [entityId]: makeFile(Buffer.from('this is not json')) })
    })

    it('should reject with an InvalidRequestError instead of crashing', async () => {
      const error = await deployEntity(context).catch((e) => e)

      expect(error).toBeInstanceOf(InvalidRequestError)
      expect(error.message).toBe('The entity file is not valid JSON.')
    })
  })

  describe('when the entity file is not valid UTF-8', () => {
    let entityBytes: Buffer
    let deploy: jest.Mock

    beforeEach(async () => {
      entityBytes = Buffer.concat([
        Buffer.from('{"type":"scene","pointers":["0,0"],"content":[],"metadata":{"title":"a'),
        Buffer.from([0xff]),
        Buffer.from('"}}')
      ])
      deploy = jest.fn().mockResolvedValue({ message: 'deployed' })
      const context = createContext(entityId, { [entityId]: makeFile(entityBytes) })
      context.components.sceneDeployments.deploy = deploy
      await deployEntity(context)
    })

    it('should deploy the uploaded bytes unchanged', () => {
      expect(Buffer.from(deploy.mock.calls[0][0].entityFile)).toStrictEqual(entityBytes)
    })
  })

  describe('when the entity file starts with a byte order mark', () => {
    let deploy: jest.Mock

    beforeEach(async () => {
      const entityBytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify({ type: 'scene', pointers: ['0,0'], content: [] }))
      ])
      deploy = jest.fn().mockResolvedValue({ message: 'deployed' })
      const context = createContext(entityId, { [entityId]: makeFile(entityBytes) })
      context.components.sceneDeployments.deploy = deploy
      await deployEntity(context)
    })

    it('should parse the entity after the byte order mark', () => {
      expect(deploy.mock.calls[0][0].deployment.entity).toEqual(
        expect.objectContaining({ id: entityId, type: 'scene', pointers: ['0,0'] })
      )
    })
  })

  describe('when a regular deployment is not validly signed', () => {
    let validateSignatureSpy: jest.SpyInstance
    let withRead: jest.Mock
    let caughtError: unknown

    beforeEach(async () => {
      validateSignatureSpy = jest
        .spyOn(Authenticator, 'validateSignature')
        .mockResolvedValue({ ok: false, message: 'bad signature' })
      withRead = jest.fn()
      const baseContext = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      const context = {
        ...baseContext,
        components: { ...baseContext.components, contentLocks: { withRead } }
      } as unknown as DeployContext
      caughtError = await deployEntity(context).catch((error) => error)
    })

    afterEach(() => {
      validateSignatureSpy.mockRestore()
      jest.resetAllMocks()
    })

    it('should reject it without taking any content lock', () => {
      expect({ caughtError, locks: withRead.mock.calls.length }).toEqual({
        caughtError: new InvalidRequestError('Deployment failed: bad signature'),
        locks: 0
      })
    })
  })

  describe('when a partial request is not validly signed', () => {
    let validateSignatureSpy: jest.SpyInstance
    let withRead: jest.Mock
    let caughtError: unknown

    beforeEach(async () => {
      validateSignatureSpy = jest
        .spyOn(Authenticator, 'validateSignature')
        .mockResolvedValue({ ok: false, message: 'bad signature' })
      withRead = jest.fn()
      const baseContext = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      baseContext.formData.fields.partial = makeField('true')
      const context = {
        ...baseContext,
        components: { ...baseContext.components, contentLocks: { withRead } }
      } as unknown as DeployContext
      caughtError = await deployEntity(context).catch((error) => error)
    })

    afterEach(() => {
      validateSignatureSpy.mockRestore()
      jest.resetAllMocks()
    })

    it('should reject it without taking any content lock', () => {
      expect({ caughtError, locks: withRead.mock.calls.length }).toEqual({
        caughtError: new InvalidRequestError('Invalid auth chain: bad signature'),
        locks: 0
      })
    })
  })

  describe('when a partial batch carrying the manifest fails its staging validation', () => {
    let withRead: jest.Mock
    let prevalidate: jest.Mock
    let caughtError: unknown

    beforeEach(async () => {
      withRead = jest.fn()
      prevalidate = jest.fn().mockRejectedValue(new InvalidRequestError('Deployment failed: no permission'))
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.formData.fields.partial = makeField('true')
      context.components.contentLocks = { withRead } as unknown as DeployContext['components']['contentLocks']
      ;(context.components.sceneDeployments as unknown as { prevalidate: jest.Mock }).prevalidate = prevalidate
      caughtError = await deployEntity(context).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject it without taking any content lock', () => {
      expect({ caughtError, locks: withRead.mock.calls.length }).toEqual({
        caughtError: new InvalidRequestError('Deployment failed: no permission'),
        locks: 0
      })
    })
  })

  describe('when a partial batch carrying the manifest passes its staging validation', () => {
    let pending: { deployer: string; createdAt: Date }
    let prevalidate: jest.Mock
    let stage: jest.Mock
    let getByEntityId: jest.Mock
    let findPublication: jest.Mock
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      pending = { deployer: '0x0000000000000000000000000000000000000001', createdAt: new Date(1_000) }
      prevalidate = jest.fn().mockResolvedValue({ sawPending: true })
      stage = jest.fn().mockResolvedValue({ complete: false, missing: ['missing-hash'] })
      getByEntityId = jest.fn().mockResolvedValue(pending)
      findPublication = jest.fn().mockResolvedValue(undefined)
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.formData.fields.partial = makeField('true')
      ;(context.components.partialUploadAdmission as unknown as { getByEntityId: jest.Mock }).getByEntityId =
        getByEntityId
      context.components.sceneDeployments = {
        findPublication,
        prevalidate,
        stage
      } as unknown as DeployContext['components']['sceneDeployments']
      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should validate it against the pending upload read before the lock', () => {
      expect(prevalidate.mock.calls[0][1]).toBe(pending)
    })

    it('should read the pending upload before looking for a publication', () => {
      expect(getByEntityId.mock.invocationCallOrder[0]).toBeLessThan(findPublication.mock.invocationCallOrder[0])
    })

    it('should stage it with the outcome of that validation', () => {
      expect({ prevalidation: stage.mock.calls[0][0].prevalidation, response }).toEqual({
        prevalidation: { sawPending: true },
        response: { status: 202, body: { missing: ['missing-hash'] } }
      })
    })
  })

  describe('when a regular deployment fails its pre-storage validation', () => {
    let withRead: jest.Mock
    let caughtError: unknown

    beforeEach(async () => {
      withRead = jest.fn()
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.components.contentLocks = { withRead } as unknown as DeployContext['components']['contentLocks']
      context.components.validator = {
        validateBeforeStorage: jest.fn().mockResolvedValue({ ok: () => false, errors: ['no permission'] })
      } as unknown as DeployContext['components']['validator']
      caughtError = await deployEntity(context).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject it without taking any content lock', () => {
      expect({ caughtError, locks: withRead.mock.calls.length }).toEqual({
        caughtError: new InvalidRequestError('Deployment failed: no permission'),
        locks: 0
      })
    })
  })

  describe('when a partial batch carrying the manifest targets an entity published before the lock', () => {
    let withRead: jest.Mock
    let prevalidate: jest.Mock
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      withRead = jest.fn()
      prevalidate = jest.fn()
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.formData.fields.partial = makeField('true')
      context.components.contentLocks = { withRead } as unknown as DeployContext['components']['contentLocks']
      context.components.sceneDeployments = {
        findPublication: jest
          .fn()
          .mockResolvedValue({ complete: true, creationTimestamp: 789, result: { message: 'published' } }),
        prevalidate
      } as unknown as DeployContext['components']['sceneDeployments']
      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should answer with the publication without validating it or taking any content lock', () => {
      expect({ response, validations: prevalidate.mock.calls.length, locks: withRead.mock.calls.length }).toEqual({
        response: { status: 200, body: { creationTimestamp: 789, message: 'published' } },
        validations: 0,
        locks: 0
      })
    })
  })

  describe('when a partial batch is rejected as invalid', () => {
    let validateSignatureSpy: jest.SpyInstance
    let increment: jest.Mock

    beforeEach(async () => {
      validateSignatureSpy = jest
        .spyOn(Authenticator, 'validateSignature')
        .mockResolvedValue({ ok: false, message: 'bad signature' })
      increment = jest.fn()
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.formData.fields.partial = makeField('true')
      context.components.metrics = { increment } as unknown as DeployContext['components']['metrics']
      await deployEntity(context).catch(() => undefined)
    })

    afterEach(() => {
      validateSignatureSpy.mockRestore()
      jest.resetAllMocks()
    })

    it('should count it as a validation error', () => {
      expect(increment.mock.calls).toEqual([['partial_upload_requests', { outcome: 'validation_error' }]])
    })
  })

  describe('when a regular deployment is rejected as invalid', () => {
    let validateSignatureSpy: jest.SpyInstance
    let increment: jest.Mock

    beforeEach(async () => {
      validateSignatureSpy = jest
        .spyOn(Authenticator, 'validateSignature')
        .mockResolvedValue({ ok: false, message: 'bad signature' })
      increment = jest.fn()
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.components.metrics = { increment } as unknown as DeployContext['components']['metrics']
      await deployEntity(context).catch(() => undefined)
    })

    afterEach(() => {
      validateSignatureSpy.mockRestore()
      jest.resetAllMocks()
    })

    it('should not count it as a partial upload batch', () => {
      expect(increment.mock.calls).toEqual([])
    })
  })

  describe('when a partial batch carrying the manifest targets a published entity', () => {
    let validateSignatureSpy: jest.SpyInstance
    let stage: jest.Mock
    let increment: jest.Mock
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      validateSignatureSpy = jest.spyOn(Authenticator, 'validateSignature').mockResolvedValue({ ok: true })
      stage = jest.fn()
      increment = jest.fn()
      const baseContext = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      baseContext.formData.fields.partial = makeField('true')
      const context = {
        ...baseContext,
        components: {
          ...baseContext.components,
          metrics: { increment },
          sceneDeployments: {
            stage,
            findPublication: jest
              .fn()
              .mockResolvedValue({ complete: true, creationTimestamp: 789, result: { message: 'published' } })
          }
        }
      } as unknown as DeployContext
      response = await deployEntity(context)
    })

    afterEach(() => {
      validateSignatureSpy.mockRestore()
      jest.resetAllMocks()
    })

    it('should answer 200 with the publication without staging the batch', () => {
      expect({ response, stages: stage.mock.calls.length }).toEqual({
        response: { status: 200, body: { creationTimestamp: 789, message: 'published' } },
        stages: 0
      })
    })

    it('should count the batch as finalized', () => {
      expect(increment.mock.calls).toEqual([['partial_upload_requests', { outcome: 'finalized' }]])
    })
  })

  describe('when the partial query parameter is sent', () => {
    let withRead: jest.Mock
    let context: DeployContext
    let caughtError: unknown

    beforeEach(() => {
      withRead = jest.fn()
      const baseContext = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context = {
        ...baseContext,
        components: { ...baseContext.components, contentLocks: { withRead } },
        url: new URL('https://request.example/entities?partial=true')
      } as unknown as DeployContext
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    describe('and the partial form field is missing', () => {
      beforeEach(async () => {
        caughtError = await deployEntity(context).catch((error) => error)
      })

      it('should reject it without taking any content lock', () => {
        expect({ caughtError, locks: withRead.mock.calls.length }).toEqual({
          caughtError: new InvalidRequestError(
            "The 'partial=true' query parameter requires the 'partial=true' form field"
          ),
          locks: 0
        })
      })
    })

    describe('and the partial form field is not true', () => {
      beforeEach(async () => {
        context.formData.fields.partial = makeField('false')
        caughtError = await deployEntity(context).catch((error) => error)
      })

      it('should reject it without taking any content lock', () => {
        expect({ caughtError, locks: withRead.mock.calls.length }).toEqual({
          caughtError: new InvalidRequestError(
            "The 'partial=true' query parameter requires the 'partial=true' form field"
          ),
          locks: 0
        })
      })
    })

    describe('and the partial form field is true but the request is not validly signed', () => {
      let validateSignatureSpy: jest.SpyInstance

      beforeEach(async () => {
        validateSignatureSpy = jest
          .spyOn(Authenticator, 'validateSignature')
          .mockResolvedValue({ ok: false, message: 'bad signature' })
        context.formData.fields.partial = makeField('true')
        caughtError = await deployEntity(context).catch((error) => error)
      })

      afterEach(() => {
        validateSignatureSpy.mockRestore()
      })

      it('should handle it as a partial request', () => {
        expect(caughtError).toEqual(new InvalidRequestError('Invalid auth chain: bad signature'))
      })
    })
  })

  describe('when a partial resume request omits the entity file', () => {
    let validateSignatureSpy: jest.SpyInstance
    let getByEntityId: jest.Mock
    let retrieve: jest.Mock
    let caughtError: unknown

    function createResumeContext(): DeployContext {
      const baseContext = createContext(entityId, {})
      baseContext.formData.fields.partial = makeField('true')
      return {
        ...baseContext,
        components: {
          ...baseContext.components,
          partialUploadAdmission: {
            getByEntityId,
            getCompleted: jest.fn().mockResolvedValue(undefined)
          },
          storage: { retrieve }
        }
      } as unknown as DeployContext
    }

    beforeEach(() => {
      // The signature gate alone must never authorize the storage read-back — any keypair can produce
      // a valid signature over any entity id — so it is mocked as passing in every context here.
      validateSignatureSpy = jest.spyOn(Authenticator, 'validateSignature').mockResolvedValue({ ok: true })
      retrieve = jest.fn().mockResolvedValue(undefined)
    })

    afterEach(() => {
      validateSignatureSpy.mockRestore()
      jest.resetAllMocks()
    })

    describe('and no pending upload exists for the entity', () => {
      beforeEach(async () => {
        getByEntityId = jest.fn().mockResolvedValue(undefined)
        caughtError = await deployEntity(createResumeContext()).catch((error) => error)
      })

      it('should reject asking for the entity file without reading storage', () => {
        expect({ caughtError, retrieves: retrieve.mock.calls.length }).toEqual({
          caughtError: new InvalidRequestError(
            `The first partial request for an entity must include the entity file "${entityId}".`
          ),
          retrieves: 0
        })
      })
    })

    describe('and the pending upload belongs to a different deployer', () => {
      beforeEach(async () => {
        getByEntityId = jest.fn().mockResolvedValue({ deployer: '0xsomeoneelse', createdAt: new Date() })
        caughtError = await deployEntity(createResumeContext()).catch((error) => error)
      })

      it('should reject asking for the entity file without reading storage', () => {
        expect({ caughtError, retrieves: retrieve.mock.calls.length }).toEqual({
          caughtError: new InvalidRequestError(
            `The first partial request for an entity must include the entity file "${entityId}".`
          ),
          retrieves: 0
        })
      })
    })

    describe('and the pending upload belongs to the signer but storage no longer has the entity file', () => {
      beforeEach(async () => {
        // createContext signs with an all-lowercase address payload; the pending row stores deployers lowercased.
        getByEntityId = jest
          .fn()
          .mockResolvedValue({ deployer: '0x0000000000000000000000000000000000000001', createdAt: new Date() })
        caughtError = await deployEntity(createResumeContext()).catch((error) => error)
      })

      it('should read the entity back from storage', () => {
        expect(retrieve).toHaveBeenCalledWith(entityId)
      })

      it('should reject asking for the entity file', () => {
        expect(caughtError).toStrictEqual(
          new InvalidRequestError(`The first partial request for an entity must include the entity file "${entityId}".`)
        )
      })
    })

    describe('and the stored entity file streams past the cap without size metadata', () => {
      let stage: jest.Mock
      let pulledChunks: number
      let chunkSize: number

      beforeEach(async () => {
        getByEntityId = jest
          .fn()
          .mockResolvedValue({ deployer: '0x0000000000000000000000000000000000000001', createdAt: new Date() })
        chunkSize = 1024 * 1024
        const chunk = Buffer.alloc(chunkSize, 'a')
        pulledChunks = 0
        // Unbounded in practice; the backstop only keeps a read-all regression from hanging the suite.
        retrieve = jest.fn().mockResolvedValue({
          size: null,
          asStream: async () =>
            (async function* () {
              while (pulledChunks < 1024) {
                pulledChunks++
                yield chunk
              }
            })()
        })
        stage = jest.fn()
        const context = createResumeContext()
        ;(context.components.sceneDeployments as unknown as { stage: jest.Mock }).stage = stage
        caughtError = await deployEntity(context).catch((error) => error)
      })

      it('should reject it as too large', () => {
        expect(caughtError).toStrictEqual(
          new InvalidRequestError(`The stored entity file is too large (over ${MAX_ENTITY_FILE_SIZE_IN_BYTES} bytes).`)
        )
      })

      it('should stop reading right after crossing the cap', () => {
        // +1 for the chunk that crosses the cap, +1 for Readable.from's single read-ahead.
        expect(pulledChunks).toBe(Math.floor(MAX_ENTITY_FILE_SIZE_IN_BYTES / chunkSize) + 2)
      })

      it('should not stage the batch', () => {
        expect(stage).not.toHaveBeenCalled()
      })
    })

    describe('and the stored entity file is read back', () => {
      let storedEntity: Buffer
      let expectedHash: string
      let stagedManifest: { size: number; hash: string }

      beforeEach(async () => {
        getByEntityId = jest
          .fn()
          .mockResolvedValue({ deployer: '0x0000000000000000000000000000000000000001', createdAt: new Date() })
        storedEntity = Buffer.from(JSON.stringify({ type: 'scene', pointers: ['0,0'], content: [] }))
        expectedHash = await hashV1(storedEntity)
        // Streamed in two chunks, the second as a string, to exercise the reassembly.
        retrieve = jest.fn().mockResolvedValue({
          asStream: async () =>
            (async function* () {
              yield storedEntity.subarray(0, 10)
              yield storedEntity.subarray(10).toString()
            })()
        })
        const context = createResumeContext()
        ;(context.components.sceneDeployments as unknown as { stage: jest.Mock }).stage = jest.fn(
          async (input: { manifest: { size: number; getHash(): Promise<string> } }) => {
            stagedManifest = { size: input.manifest.size, hash: await input.manifest.getHash() }
            return { complete: false, missing: [] }
          }
        )
        await deployEntity(context)
      })

      it('should stage it with a manifest matching the stored bytes', () => {
        expect(stagedManifest).toEqual({ size: storedEntity.length, hash: expectedHash })
      })
    })

    describe('and the signer authenticates with a checksummed address', () => {
      beforeEach(() => {
        getByEntityId = jest
          .fn()
          .mockResolvedValue({ deployer: '0xabcdef0000000000000000000000000000000001', createdAt: new Date() })
      })

      describe('and the request omits every file', () => {
        beforeEach(async () => {
          const context = createResumeContext()
          context.formData.fields['authChain[0][payload]'] = makeField('0xAbCdEf0000000000000000000000000000000001')
          caughtError = await deployEntity(context).catch((error) => error)
        })

        it('should recognize its own upload and read the entity back from storage', () => {
          expect(retrieve).toHaveBeenCalledWith(entityId)
        })
      })

      describe('and the request carries a content file', () => {
        let stagedHash: unknown
        let expectedHash: string

        beforeEach(async () => {
          retrieve = jest.fn().mockResolvedValue({ asStream: async () => bufferToStream(Buffer.from('{}')) })
          const content = makeFile(Buffer.from('content'))
          expectedHash = await hashV1(Buffer.from('content'))
          const context = createResumeContext()
          context.formData.fields['authChain[0][payload]'] = makeField('0xAbCdEf0000000000000000000000000000000001')
          context.formData.files = { [expectedHash]: content }
          context.components.contentLocks = {
            withRead: async (operation: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) => {
              rmSync(content.filepath)
              return operation(signal)
            }
          } as unknown as DeployContext['components']['contentLocks']
          ;(context.components.sceneDeployments as unknown as { stage: jest.Mock }).stage = jest.fn(
            async (input: { files: Map<string, { getHash(): Promise<string> }> }) => {
              stagedHash = await input.files
                .get(expectedHash)!
                .getHash()
                .catch((error: Error) => error.message)
              return { complete: false, missing: [] }
            }
          )
          await deployEntity(context)
        })

        it('should hash the content file before taking the content lock', () => {
          expect(stagedHash).toBe(expectedHash)
        })
      })
    })

    describe('and the signer resumes its upload with a content file', () => {
      let content: ReturnType<typeof makeFile>
      let stagedHash: unknown
      let expectedHash: string

      beforeEach(async () => {
        getByEntityId = jest
          .fn()
          .mockResolvedValue({ deployer: '0x0000000000000000000000000000000000000001', createdAt: new Date() })
        retrieve = jest.fn().mockResolvedValue({ asStream: async () => bufferToStream(Buffer.from('{}')) })
        content = makeFile(Buffer.from('content'))
        expectedHash = await hashV1(Buffer.from('content'))
        const context = createResumeContext()
        context.formData.files = { [expectedHash]: content }
        // The temp file is gone once the lock is taken, so only a hash computed before it can be read.
        context.components.contentLocks = {
          withRead: async (operation: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) => {
            rmSync(content.filepath)
            return operation(signal)
          }
        } as unknown as DeployContext['components']['contentLocks']
        context.components.sceneDeployments = {
          findPublication: jest.fn().mockResolvedValue(undefined),
          stage: jest.fn(async (input: { files: Map<string, { getHash(): Promise<string> }> }) => {
            stagedHash = await input.files
              .get(expectedHash)!
              .getHash()
              .catch((error: Error) => error.message)
            return { complete: false, missing: [] }
          })
        } as unknown as DeployContext['components']['sceneDeployments']
        await deployEntity(context)
      })

      it('should hash the content file before taking the content lock', () => {
        expect(stagedHash).toBe(expectedHash)
      })
    })

    describe('and another signer sends a content file whose upload it does not own', () => {
      beforeEach(async () => {
        getByEntityId = jest.fn().mockResolvedValue({ deployer: '0xsomeoneelse', createdAt: new Date() })
        const content = makeFile(Buffer.from('content'))
        // Unreadable: hashing it before the lock would fail the request with a read error.
        rmSync(content.filepath)
        const context = createResumeContext()
        context.formData.files = { 'content-hash': content }
        caughtError = await deployEntity(context).catch((error) => error)
      })

      it('should not hash it, asking for the entity file instead', () => {
        expect(caughtError).toEqual(
          new InvalidRequestError(`The first partial request for an entity must include the entity file "${entityId}".`)
        )
      })
    })

    describe('and the entity is already published', () => {
      let response: Awaited<ReturnType<typeof deployEntity>>
      let findPublication: jest.Mock

      beforeEach(async () => {
        getByEntityId = jest.fn().mockResolvedValue(undefined)
        findPublication = jest
          .fn()
          .mockResolvedValue({ complete: true, creationTimestamp: 789, result: { message: 'published' } })
        const context = createResumeContext()
        ;(context.components as any).sceneDeployments = { findPublication }
        response = await deployEntity(context)
      })

      it('should answer 200 with the publication without reading storage or requiring the entity file', () => {
        expect({ response, retrieves: retrieve.mock.calls.length }).toEqual({
          response: { status: 200, body: { creationTimestamp: 789, message: 'published' } },
          retrieves: 0
        })
      })
    })

    describe('and the signer holds a completion receipt', () => {
      let response: Awaited<ReturnType<typeof deployEntity>>
      let findPublication: jest.Mock

      beforeEach(async () => {
        getByEntityId = jest.fn().mockResolvedValue(undefined)
        findPublication = jest.fn()
        const context = createResumeContext()
        ;(context.components as any).sceneDeployments = { findPublication }
        ;(context.components as any).partialUploadAdmission.getCompleted = jest
          .fn()
          .mockResolvedValue({ creationTimestamp: 456, worldName: 'world.dcl.eth', parcels: ['0,0'] })
        response = await deployEntity(context)
      })

      it('should answer with the original completion before looking up the publication', () => {
        expect({ status: response.status, body: response.body, lookups: findPublication.mock.calls.length }).toEqual({
          status: 200,
          body: expect.objectContaining({ creationTimestamp: 456 }),
          lookups: 0
        })
      })
    })
  })

  describe('when the processing stages of a partial resume request are tracked', () => {
    let recorder: StageRecorder
    let context: DeployContext
    let stagesByCall: Record<string, DeploymentProcessingStage[][]>
    let withRead: jest.Mock

    function recording<T>(name: string, implementation: () => T): jest.Mock {
      return jest.fn(() => {
        ;(stagesByCall[name] ??= []).push(recorder.openStages())
        return implementation()
      })
    }

    beforeEach(async () => {
      recorder = createStageRecorder()
      stagesByCall = {}
      const content = Buffer.from('content')
      const contentHash = await hashV1(content)
      context = createContext(entityId, { [contentHash]: makeFile(content) })
      context.formData.fields.partial = makeField('true')
      withRead = recording('withRead', () => undefined)
      context.components = {
        ...context.components,
        contentLocks: {
          withRead: async (operation: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) => {
            withRead()
            return operation(signal)
          }
        },
        deploymentProcessing: createDeploymentProcessingMock({
          trackStage: recorder.trackStage,
          trackWorker: jest.fn(async <T>(_stage: DeploymentProcessingStage, operation: () => Promise<T>) => {
            ;(stagesByCall.hashWorker ??= []).push(recorder.openStages())
            return operation()
          }) as jest.MockedFunction<<T>(stage: DeploymentProcessingStage, operation: () => Promise<T>) => Promise<T>>
        }),
        partialUploadAdmission: {
          getByEntityId: recording('getByEntityId', async () => ({
            deployer: '0x0000000000000000000000000000000000000001',
            createdAt: new Date()
          })),
          getCompleted: recording('getCompleted', async () => undefined)
        },
        storage: {
          retrieve: recording('retrieve', async () => ({ asStream: async () => bufferToStream(Buffer.from('{}')) }))
        },
        sceneDeployments: {
          findPublication: jest.fn().mockResolvedValue(undefined),
          stage: recording('stage', async () => ({ complete: false, missing: [] }))
        }
      } as unknown as DeployContext['components']
    })

    describe('and the batch is staged', () => {
      beforeEach(async () => {
        await deployEntity(context)
      })

      it('should read the pending upload inside the lookup stage before and under the lock', () => {
        expect(stagesByCall.getByEntityId).toEqual([
          ['total', 'lookup'],
          ['total', 'lookup']
        ])
      })

      it('should check for a replay inside the lookup stage before and under the lock', () => {
        expect(stagesByCall.getCompleted).toEqual([
          ['total', 'lookup'],
          ['total', 'lookup']
        ])
      })

      it('should read the stored manifest back inside the lookup stage', () => {
        expect(stagesByCall.retrieve).toEqual([['total', 'lookup']])
      })

      it('should hash the uploaded content file inside the hash stage', () => {
        expect(stagesByCall.hashWorker).toEqual([['total', 'hash']])
      })

      it('should count the uploaded files as the hash stage items', () => {
        expect(recorder.trackStage).toHaveBeenCalledWith('hash', 1, expect.any(Function))
      })

      it('should wait for the content lock inside the lock stage', () => {
        expect(stagesByCall.withRead).toEqual([['total', 'lock']])
      })

      it('should close the lock stage once the lock is acquired', () => {
        expect(stagesByCall.stage).toEqual([['total']])
      })
    })

    describe('and the content lock cannot be acquired', () => {
      let lockError: Error
      let lockStageOutcome: unknown

      beforeEach(async () => {
        lockError = new Error('lock unavailable')
        context.components.contentLocks = {
          withRead: jest.fn().mockRejectedValue(lockError)
        } as unknown as DeployContext['components']['contentLocks']
        await deployEntity(context).catch(() => undefined)
        const lockCall = recorder.trackStage.mock.calls.findIndex(([stage]) => stage === 'lock')
        lockStageOutcome = await recorder.trackStage.mock.results[lockCall].value.catch((error: unknown) => error)
      })

      it('should fail the lock stage with the lock error', () => {
        expect(lockStageOutcome).toBe(lockError)
      })
    })

    describe('and the content lock returns without running the operation', () => {
      let lockStageState: string

      beforeEach(async () => {
        context.components.contentLocks = {
          withRead: jest.fn().mockResolvedValue({ status: 200, body: {} })
        } as unknown as DeployContext['components']['contentLocks']
        await deployEntity(context).catch(() => undefined)
        const lockCall = recorder.trackStage.mock.calls.findIndex(([stage]) => stage === 'lock')
        lockStageState = await Promise.race([
          recorder.trackStage.mock.results[lockCall].value.then(() => 'settled'),
          new Promise<string>((resolve) => setImmediate(() => resolve('pending')))
        ])
      })

      it('should still close the lock stage', () => {
        expect(lockStageState).toBe('settled')
      })
    })
  })

  describe('when the entity file exceeds the safe in-memory size', () => {
    let context: DeployContext
    let entityFile: ReturnType<typeof makeFile>

    beforeEach(() => {
      entityFile = makeFile(Buffer.from('{}'))
      entityFile.size = MAX_ENTITY_FILE_SIZE_IN_BYTES + 1
      context = createContext(entityId, { [entityId]: entityFile })
    })

    it('should reject the deployment before reading and parsing the entity file', async () => {
      const error = await deployEntity(context).catch((e) => e)

      expect(error).toEqual(
        new InvalidRequestError(
          `The entity file is too large. The maximum allowed size is ${MAX_ENTITY_FILE_SIZE_IN_BYTES} bytes.`
        )
      )
    })

    describe('and the request is a partial batch', () => {
      let error: unknown

      beforeEach(async () => {
        context.formData.fields.partial = makeField('true')
        error = await deployEntity(context).catch((e: unknown) => e)
      })

      it('should reject it with the same cap', () => {
        expect(error).toEqual(
          new InvalidRequestError(
            `The entity file is too large. The maximum allowed size is ${MAX_ENTITY_FILE_SIZE_IN_BYTES} bytes.`
          )
        )
      })
    })
  })

  describe('when a valid deployment contains uploaded and stored content', () => {
    let availability: Array<[string, boolean]>
    let contentFileInfos: Array<[string, FileInfo | undefined]>
    let deploymentSize: number
    let entityHash: string
    let expectedEntityHash: string
    let fileInfo: jest.Mock
    let metadataRequests: string[]
    let responseStatus: number

    beforeEach(async () => {
      const uploadedHash = 'uploaded-hash'
      const storedHash = 'stored-hash'
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [
          { hash: uploadedHash, file: 'uploaded.bin' },
          { hash: storedHash, file: 'stored.bin' },
          { hash: storedHash, file: 'stored-copy.bin' }
        ],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      }
      const entityBuffer = Buffer.from(JSON.stringify(entity))
      const entityFile = makeFile(entityBuffer)
      const uploadedFile = makeFile(Buffer.from('12345'))
      fileInfo = jest.fn(async (hash: string) =>
        hash === storedHash ? { contentSize: 7, encoding: null, size: 7 } : undefined
      )
      expectedEntityHash = await hashV1(entityBuffer)
      const validateBeforeStorage = jest.fn(async (deployment: DeploymentToValidate) => {
        deployment.sceneReplacementAuthorization = { mode: 'unrestricted-owner' }
        rmSync(entityFile.filepath)
        entityHash = await deployment.files.get(entityId).getHash()
        return { errors: [], ok: () => true }
      })
      const validateAfterStorage = jest.fn().mockResolvedValue({ errors: [], ok: () => true })
      const entityDeployerDeploy = jest.fn().mockResolvedValue({ message: 'deployed' })
      const context = {
        ...createContext(entityId, { [entityId]: entityFile, [uploadedHash]: uploadedFile }),
        components: {
          config: {
            getString: jest.fn().mockResolvedValue('https://configured.example')
          },
          contentLocks: {
            withRead: async (operation: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) =>
              operation(signal)
          },
          deploymentProcessing: createDeploymentProcessingMock({ fileInfoConcurrency: 2 }),
          entityDeployer: { deployEntity: entityDeployerDeploy },
          logs: { getLogger: jest.fn().mockReturnValue({ info: jest.fn() }) },
          partialUploadAdmission: {
            getByEntityId: jest.fn().mockResolvedValue(undefined),
            getCompleted: jest.fn().mockResolvedValue(undefined)
          },
          storage: { fileInfo },
          validator: { validateAfterStorage, validateBeforeStorage }
        },
        url: new URL('https://request.example/entities')
      } as unknown as DeployContext

      const response = await deployEntity(context)
      const validatedDeployment = validateAfterStorage.mock.calls[0][0]
      const deployerArguments = entityDeployerDeploy.mock.calls[0]
      availability = Array.from(validatedDeployment.contentHashesInStorage)
      contentFileInfos = Array.from(validatedDeployment.contentFileInfos)
      deploymentSize = deployerArguments[6]
      metadataRequests = fileInfo.mock.calls.map(([hash]) => hash)
      responseStatus = response.status
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reuse one metadata snapshot for validation and deployment size', () => {
      expect({
        availability,
        contentFileInfos,
        deploymentSize,
        entityHash,
        metadataRequests,
        responseStatus
      }).toEqual({
        availability: [
          ['uploaded-hash', false],
          ['stored-hash', true]
        ],
        contentFileInfos: [
          ['uploaded-hash', undefined],
          ['stored-hash', { contentSize: 7, encoding: null, size: 7 }]
        ],
        deploymentSize: 12,
        entityHash: expectedEntityHash,
        metadataRequests: ['uploaded-hash', 'stored-hash'],
        responseStatus: 200
      })
    })
  })

  describe('when after-storage validation rejects the deployment', () => {
    let caughtError: unknown
    let entityDeployerDeploy: jest.Mock
    let validateAfterStorage: jest.Mock
    let lockSignal: AbortSignal

    beforeEach(async () => {
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [{ hash: 'uploaded-hash', file: 'uploaded.bin' }],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      }
      entityDeployerDeploy = jest.fn()
      lockSignal = new AbortController().signal
      validateAfterStorage = jest.fn().mockResolvedValue({
        errors: ["The hashed file doesn't match the provided content: uploaded-hash"],
        ok: () => false
      })
      const baseContext = createContext(entityId, {
        [entityId]: makeFile(Buffer.from(JSON.stringify(entity))),
        'uploaded-hash': makeFile(Buffer.from('12345'))
      })
      const context = {
        ...baseContext,
        components: {
          ...baseContext.components,
          contentLocks: {
            withRead: async (operation: (signal: AbortSignal) => Promise<unknown>) => operation(lockSignal)
          },
          config: { getString: jest.fn().mockResolvedValue(undefined) },
          entityDeployer: { deployEntity: entityDeployerDeploy },
          storage: { fileInfo: jest.fn().mockResolvedValue(undefined) },
          validator: {
            validateBeforeStorage: jest.fn().mockResolvedValue({ errors: [], ok: () => true }),
            validateAfterStorage
          }
        }
      } as unknown as DeployContext

      caughtError = await deployEntity(context).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject with the validation errors without deploying the entity', () => {
      expect({ caughtError, deployments: entityDeployerDeploy.mock.calls.length }).toEqual({
        caughtError: new InvalidRequestError(
          "Deployment failed: The hashed file doesn't match the provided content: uploaded-hash"
        ),
        deployments: 0
      })
    })

    it("should validate the stored content under the content lock's signal", () => {
      expect(validateAfterStorage.mock.calls[0][0].signal).toBe(lockSignal)
    })
  })

  describe('when the entity was already deployed by a concurrent duplicate request', () => {
    let response: Awaited<ReturnType<typeof deployEntity>>
    let getDeployedScene: jest.Mock

    beforeEach(async () => {
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      }
      getDeployedScene = jest.fn().mockResolvedValue({ entityId, createdAt: new Date(321) })
      const baseContext = createContext(entityId, { [entityId]: makeFile(Buffer.from(JSON.stringify(entity))) })
      const context = {
        ...baseContext,
        components: {
          ...baseContext.components,
          contentLocks: {
            withRead: async (operation: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) =>
              operation(signal)
          },
          config: { getString: jest.fn().mockResolvedValue(undefined) },
          entityDeployer: {
            deployEntity: jest
              .fn()
              .mockRejectedValue(
                new DeploymentUniqueViolationError(
                  entityId,
                  Object.assign(new Error('duplicate key'), { code: '23505' })
                )
              )
          },
          storage: { fileInfo: jest.fn().mockResolvedValue(undefined) },
          validator: {
            validateBeforeStorage: jest.fn(async (deployment: DeploymentToValidate) => {
              deployment.sceneReplacementAuthorization = { mode: 'unrestricted-owner' }
              return { errors: [], ok: () => true }
            }),
            validateAfterStorage: jest.fn().mockResolvedValue({ errors: [], ok: () => true })
          },
          worldsManager: { getDeployedScene }
        }
      } as unknown as DeployContext

      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should respond with an idempotent success verified against the deployed scenes', () => {
      expect({ status: response.status, queried: getDeployedScene.mock.calls[0] }).toEqual({
        status: 200,
        queried: [entityId, 'world.dcl.eth']
      })
    })

    it("should answer with the live publication's timestamp", () => {
      expect(response.body).toEqual(expect.objectContaining({ creationTimestamp: 321 }))
    })
  })

  describe('when the deploy fails with a unique violation but the entity is not deployed', () => {
    let caughtError: unknown

    beforeEach(async () => {
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      }
      const baseContext = createContext(entityId, { [entityId]: makeFile(Buffer.from(JSON.stringify(entity))) })
      const context = {
        ...baseContext,
        components: {
          ...baseContext.components,
          contentLocks: {
            withRead: async (operation: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) =>
              operation(signal)
          },
          config: { getString: jest.fn().mockResolvedValue(undefined) },
          entityDeployer: {
            deployEntity: jest
              .fn()
              .mockRejectedValue(
                new DeploymentUniqueViolationError(
                  entityId,
                  Object.assign(new Error('duplicate key'), { code: '23505' })
                )
              )
          },
          storage: { fileInfo: jest.fn().mockResolvedValue(undefined) },
          validator: {
            validateBeforeStorage: jest.fn(async (deployment: DeploymentToValidate) => {
              deployment.sceneReplacementAuthorization = { mode: 'unrestricted-owner' }
              return { errors: [], ok: () => true }
            }),
            validateAfterStorage: jest.fn().mockResolvedValue({ errors: [], ok: () => true })
          },
          worldsManager: { getDeployedScene: jest.fn().mockResolvedValue(undefined) }
        }
      } as unknown as DeployContext

      caughtError = await deployEntity(context).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should propagate the original unique-violation error', () => {
      expect((caughtError as { code?: string }).code).toBe('23505')
    })
  })

  describe('when the authorized replacement snapshot changes before persistence', () => {
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { base: '0,0', parcels: ['0,0'] } }
      }
      const baseContext = createContext(entityId, {
        [entityId]: makeFile(Buffer.from(JSON.stringify(entity)))
      })
      const context = {
        ...baseContext,
        components: {
          ...baseContext.components,
          contentLocks: {
            withRead: async (operation: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) =>
              operation(signal)
          },
          config: { getString: jest.fn().mockResolvedValue(undefined) },
          entityDeployer: {
            deployEntity: jest.fn().mockRejectedValue(new SceneReplacementConflictError('world.dcl.eth'))
          },
          storage: { fileInfo: jest.fn() },
          validator: {
            validateBeforeStorage: jest.fn(async (deployment: DeploymentToValidate) => {
              deployment.sceneReplacementAuthorization = { mode: 'scoped', entityIds: [], canManageSettings: false }
              return { errors: [], ok: () => true }
            }),
            validateAfterStorage: jest.fn().mockResolvedValue({ errors: [], ok: () => true })
          }
        }
      } as unknown as DeployContext

      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should return a conflict response so the client can retry authorization', () => {
      expect(response).toEqual({
        status: 409,
        body: {
          error: 'Conflict',
          message: 'Scene replacement authorization changed while deploying to world "world.dcl.eth". Please retry.'
        }
      })
    })
  })

  describe('when a partial-upload quota is full', () => {
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.components.contentLocks = {
        withRead: jest
          .fn()
          .mockRejectedValueOnce(
            new PartialUploadQuotaExceededError('bytes_per_minute', 'This account sent too much this minute.', 42)
          )
      } as unknown as DeployContext['components']['contentLocks']
      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should answer 429 with the quota message and its Retry-After', () => {
      expect(response).toEqual({
        status: 429,
        headers: { 'Retry-After': '42' },
        body: { error: 'Too Many Requests', message: 'This account sent too much this minute.' }
      })
    })

    describe('and the request is a partial batch', () => {
      let increment: jest.Mock

      beforeEach(async () => {
        increment = jest.fn()
        const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
        context.formData.fields.partial = makeField('true')
        context.components.metrics = { increment } as unknown as DeployContext['components']['metrics']
        context.components.contentLocks = {
          withRead: jest
            .fn()
            .mockRejectedValueOnce(
              new PartialUploadQuotaExceededError('bytes_per_server', 'The server staging is full.', 42)
            )
        } as unknown as DeployContext['components']['contentLocks']
        await deployEntity(context)
      })

      it('should count it as throttled by the quota that rejected it', () => {
        expect(increment.mock.calls).toEqual([
          ['partial_upload_throttled', { reason: 'bytes_per_server' }],
          ['partial_upload_requests', { outcome: 'throttled' }]
        ])
      })
    })
  })

  describe('when a partial upload exceeds a quota on its own', () => {
    let tooLarge: PartialUploadTooLargeError
    let error: unknown

    beforeEach(async () => {
      tooLarge = new PartialUploadTooLargeError('bytes_per_account', 'This upload needs too much staging.')
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.formData.fields.partial = makeField('true')
      context.components.metrics = { increment: jest.fn() } as unknown as DeployContext['components']['metrics']
      context.components.contentLocks = {
        withRead: jest.fn().mockRejectedValueOnce(tooLarge)
      } as unknown as DeployContext['components']['contentLocks']
      error = await deployEntity(context).catch((e: unknown) => e)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should propagate it as a 400 request error instead of a 429 retry', () => {
      expect({ error, isRequestError: error instanceof InvalidRequestError }).toEqual({
        error: tooLarge,
        isRequestError: true
      })
    })
  })

  describe('when deployment processing has exceeded its deadline', () => {
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      }
      const controller = new AbortController()
      controller.abort(new DeploymentProcessingTimeoutError(10))
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from(JSON.stringify(entity))) })
      context.components.deploymentProcessing = createDeploymentProcessingMock({
        createAbortContext: jest.fn(() => ({ signal: controller.signal, deadlineAt: Date.now(), dispose: jest.fn() }))
      })

      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should return a request-timeout response', () => {
      expect(response).toEqual({
        status: 408,
        body: {
          error: 'Request Timeout',
          message:
            'The server could not finish processing the deployment within 0.01 s after receiving it. ' +
            'Retry the deployment; if it keeps timing out, report it.'
        }
      })
    })
  })

  describe('when the HTTP client disconnects during deployment processing', () => {
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      }
      const controller = new AbortController()
      controller.abort(new DeploymentProcessingAbortedError(new DOMException('Client disconnected.', 'AbortError')))
      const context = createContext(entityId, { [entityId]: makeFile(Buffer.from(JSON.stringify(entity))) })
      context.components.deploymentProcessing = createDeploymentProcessingMock({
        createAbortContext: jest.fn(() => ({ signal: controller.signal, deadlineAt: Date.now(), dispose: jest.fn() }))
      })

      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should return a client-closed response without reaching the global error handler', () => {
      expect(response).toEqual({
        status: 499,
        body: {
          error: 'Client Closed Request',
          message: 'Client disconnected.'
        }
      })
    })
  })

  describe('when the client disconnects after the processing deadline passed', () => {
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      const controller = new AbortController()
      const baseContext = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      const context = {
        ...baseContext,
        components: {
          ...baseContext.components,
          deploymentProcessing: createDeploymentProcessingMock({
            createAbortContext: jest.fn(() => ({
              signal: controller.signal,
              deadlineAt: Date.now(),
              dispose: jest.fn()
            }))
          }),
          validator: {
            validateBeforeStorage: jest.fn(async () => {
              controller.abort(new DeploymentProcessingTimeoutError(10))
              throw new DeploymentProcessingAbortedError(new DOMException('Client disconnected.', 'AbortError'))
            })
          }
        }
      } as unknown as DeployContext

      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should answer the disconnect rather than the timeout', () => {
      expect(response).toEqual({
        status: 499,
        body: { error: 'Client Closed Request', message: 'Client disconnected.' }
      })
    })
  })

  describe('when a genuine failure races with a client disconnect', () => {
    let loggerError: jest.Mock
    let response: Awaited<ReturnType<typeof deployEntity>>

    beforeEach(async () => {
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      }
      const controller = new AbortController()
      loggerError = jest.fn()
      const baseContext = createContext(entityId, { [entityId]: makeFile(Buffer.from(JSON.stringify(entity))) })
      const context = {
        ...baseContext,
        components: {
          ...baseContext.components,
          deploymentProcessing: createDeploymentProcessingMock({
            createAbortContext: jest.fn(() => ({
              signal: controller.signal,
              deadlineAt: Date.now() + 1000,
              dispose: jest.fn()
            }))
          }),
          logs: { getLogger: jest.fn().mockReturnValue({ error: loggerError }) },
          validator: {
            validateBeforeStorage: jest.fn(async () => {
              controller.abort(
                new DeploymentProcessingAbortedError(new DOMException('Client disconnected.', 'AbortError'))
              )
              throw new Error('database exploded')
            })
          }
        }
      } as unknown as DeployContext

      response = await deployEntity(context)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should log the underlying failure and still return the client-closed response', () => {
      expect({ logged: loggerError.mock.calls[0], status: response.status }).toEqual({
        logged: ['Deployment failed while cancelled', { entityId, error: 'database exploded' }],
        status: 499
      })
    })
  })

  describe('when a partial batch is answered', () => {
    let increment: jest.Mock
    let context: DeployContext
    let withRead: jest.Mock
    let response: Awaited<ReturnType<typeof deployEntity>> | undefined
    let caughtError: unknown

    beforeEach(() => {
      increment = jest.fn()
      withRead = jest.fn()
      response = undefined
      caughtError = undefined
      context = createContext(entityId, { [entityId]: makeFile(Buffer.from('{}')) })
      context.formData.fields.partial = makeField('true')
      context.components.metrics = { increment } as unknown as DeployContext['components']['metrics']
      context.components.contentLocks = { withRead } as unknown as DeployContext['components']['contentLocks']
    })

    async function run() {
      try {
        response = await deployEntity(context)
      } catch (error) {
        caughtError = error
      }
    }

    describe('and the batch is staged but content is still missing', () => {
      beforeEach(async () => {
        withRead.mockResolvedValueOnce({ status: 202, body: { missing: ['content-hash'] } })
        await run()
      })

      it('should count it as accepted', () => {
        expect(increment.mock.calls).toEqual([['partial_upload_requests', { outcome: 'accepted' }]])
      })
    })

    describe('and the processing deadline passes', () => {
      beforeEach(async () => {
        withRead.mockRejectedValueOnce(new DeploymentProcessingTimeoutError(10))
        await run()
      })

      it('should count it as timed out', () => {
        expect(increment.mock.calls).toEqual([['partial_upload_requests', { outcome: 'timeout' }]])
      })
    })

    describe('and the client disconnects', () => {
      beforeEach(async () => {
        withRead.mockRejectedValueOnce(
          new DeploymentProcessingAbortedError(new DOMException('Client disconnected.', 'AbortError'))
        )
        await run()
      })

      it('should count it as aborted', () => {
        expect(increment.mock.calls).toEqual([['partial_upload_requests', { outcome: 'aborted' }]])
      })
    })

    describe('and the replacement authorization changes before persistence', () => {
      beforeEach(async () => {
        withRead.mockRejectedValueOnce(new SceneReplacementConflictError('world.dcl.eth'))
        await run()
      })

      it('should answer 409', () => {
        expect(response?.status).toBe(409)
      })

      it('should count it as a validation error', () => {
        expect(increment.mock.calls).toEqual([['partial_upload_requests', { outcome: 'validation_error' }]])
      })
    })

    describe('and an unexpected error is thrown', () => {
      beforeEach(async () => {
        withRead.mockRejectedValueOnce(new Error('database exploded'))
        await run()
      })

      it('should propagate the error', () => {
        expect(caughtError).toStrictEqual(new Error('database exploded'))
      })

      it('should count it as an error', () => {
        expect(increment.mock.calls).toEqual([['partial_upload_requests', { outcome: 'error' }]])
      })
    })

    describe('and its auth chain is malformed', () => {
      beforeEach(async () => {
        context.formData.fields['authChain[0][type]'] = makeField('NOT_A_LINK_TYPE')
        await run()
      })

      it('should reject it as an invalid auth chain', () => {
        expect(caughtError).toStrictEqual(new InvalidRequestError('Invalid auth chain.'))
      })

      it('should not take any content lock', () => {
        expect(withRead).not.toHaveBeenCalled()
      })
    })

    describe('and a quota rejects it while the client disconnects', () => {
      beforeEach(async () => {
        const controller = new AbortController()
        context.components.deploymentProcessing = createDeploymentProcessingMock({
          createAbortContext: jest.fn(() => ({
            signal: controller.signal,
            deadlineAt: Date.now() + 1000,
            dispose: jest.fn()
          }))
        })
        withRead.mockImplementationOnce(async () => {
          controller.abort(new DeploymentProcessingAbortedError(new DOMException('Client disconnected.', 'AbortError')))
          throw new PartialUploadQuotaExceededError('bytes_per_minute', 'This account sent too much this minute.', 42)
        })
        await run()
      })

      it('should answer the disconnect without a Retry-After', () => {
        expect(response).toEqual({
          status: 499,
          body: { error: 'Client Closed Request', message: 'Client disconnected.' }
        })
      })

      it('should count it as aborted without counting it as throttled', () => {
        expect(increment.mock.calls).toEqual([['partial_upload_requests', { outcome: 'aborted' }]])
      })
    })

    describe('and a replacement conflict races with the processing deadline', () => {
      beforeEach(async () => {
        const controller = new AbortController()
        context.components.deploymentProcessing = createDeploymentProcessingMock({
          createAbortContext: jest.fn(() => ({ signal: controller.signal, deadlineAt: Date.now(), dispose: jest.fn() }))
        })
        withRead.mockImplementationOnce(async () => {
          controller.abort(new DeploymentProcessingTimeoutError(10))
          throw new SceneReplacementConflictError('world.dcl.eth')
        })
        await run()
      })

      it('should answer the timeout', () => {
        expect(response?.status).toBe(408)
      })
    })
  })
})
