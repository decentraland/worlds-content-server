import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { deployEntity } from '../../src/controllers/handlers/deploy-entity-handler'
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
})
