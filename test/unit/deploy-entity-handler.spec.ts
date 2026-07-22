import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { FileInfo, IContentStorageComponent } from '@dcl/catalyst-storage'
import {
  DEFAULT_CONTENT_FILE_INFO_CONCURRENCY,
  deployEntity,
  getContentFileInfos,
  MAX_ENTITY_FILE_SIZE_IN_BYTES
} from '../../src/controllers/handlers/deploy-entity-handler'
import { InvalidRequestError } from '@dcl/http-commons'
import { createDeploymentProcessingMock } from '../mocks/deployment-processing-mock'
import {
  DeploymentProcessingAbortedError,
  DeploymentProcessingTimeoutError
} from '../../src/logic/deployment-processing'
import { hashV1 } from '@dcl/hashing'
import { DeploymentToValidate } from '../../src/types'

type DeployContext = Parameters<typeof deployEntity>[0]

describe('deployEntity', () => {
  const entityId = 'bafkreiahsvnr4x4rnskhkwfbnbplkbqhzb3xagdwpyfy44lgcndmhyizde'
  let tmpDir: string
  let fileCounter: number

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'deploy-entity-test-'))
    fileCounter = 0
  })

  afterEach(() => {
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
        deploymentProcessing: createDeploymentProcessingMock(),
        logs: {
          getLogger: jest.fn().mockReturnValue({ debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() })
        }
      },
      formData: {
        fields: {
          entityId: makeField(id),
          'authChain[0][payload]': makeField('0xpayload'),
          'authChain[0][signature]': makeField('0xsignature'),
          'authChain[0][type]': makeField('SIGNER')
        },
        files
      },
      request: { signal: new AbortController().signal },
      url: new URL('https://request.example/entities')
    } as unknown as DeployContext
  }

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
          deploymentProcessing: createDeploymentProcessingMock({ fileInfoConcurrency: 2 }),
          entityDeployer: { deployEntity: entityDeployerDeploy },
          storage: { fileInfo },
          validator: { validateAfterStorage, validateBeforeStorage }
        },
        url: { host: 'request.example' }
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

    beforeEach(async () => {
      const entity = {
        type: 'scene',
        pointers: ['0,0'],
        timestamp: Date.now(),
        content: [{ hash: 'uploaded-hash', file: 'uploaded.bin' }],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { parcels: ['0,0'] } }
      }
      entityDeployerDeploy = jest.fn()
      const baseContext = createContext(entityId, {
        [entityId]: makeFile(Buffer.from(JSON.stringify(entity))),
        'uploaded-hash': makeFile(Buffer.from('12345'))
      })
      const context = {
        ...baseContext,
        components: {
          ...baseContext.components,
          config: { getString: jest.fn().mockResolvedValue(undefined) },
          entityDeployer: { deployEntity: entityDeployerDeploy },
          storage: { fileInfo: jest.fn().mockResolvedValue(undefined) },
          validator: {
            validateBeforeStorage: jest.fn().mockResolvedValue({ errors: [], ok: () => true }),
            validateAfterStorage: jest.fn().mockResolvedValue({
              errors: ["The hashed file doesn't match the provided content: uploaded-hash"],
              ok: () => false
            })
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
          message: 'Deployment processing exceeded the 10ms deadline.'
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
