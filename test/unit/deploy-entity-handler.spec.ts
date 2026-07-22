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
      formData: {
        fields: {
          entityId: makeField(id),
          'authChain[0][payload]': makeField('0xpayload'),
          'authChain[0][signature]': makeField('0xsignature'),
          'authChain[0][type]': makeField('SIGNER')
        },
        files
      }
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
})
