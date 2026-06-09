import { deployEntity } from '../../src/controllers/handlers/deploy-entity-handler'
import { InvalidRequestError } from '@dcl/http-commons'

type DeployContext = Parameters<typeof deployEntity>[0]

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

function makeFile(value: Buffer) {
  return { fieldname: 'file', value, filename: 'file', encoding: '7bit', mimeType: 'application/octet-stream' }
}

/**
 * Builds a minimal multipart context with a valid entityId field and a single-link auth chain,
 * so the handler reaches the entity-file handling instead of failing earlier on a missing auth chain.
 */
function createContext(entityId: string, files: Record<string, ReturnType<typeof makeFile>>): DeployContext {
  return {
    formData: {
      fields: {
        entityId: makeField(entityId),
        'authChain[0][payload]': makeField('0xpayload'),
        'authChain[0][signature]': makeField('0xsignature'),
        'authChain[0][type]': makeField('SIGNER')
      },
      files
    }
  } as unknown as DeployContext
}

describe('deployEntity', () => {
  const entityId = 'bafkreiahsvnr4x4rnskhkwfbnbplkbqhzb3xagdwpyfy44lgcndmhyizde'

  describe('when the entity file referenced by entityId is missing from the request', () => {
    let context: DeployContext

    beforeEach(() => {
      context = createContext(entityId, {})
    })

    it('should reject with an InvalidRequestError instead of crashing', async () => {
      await expect(deployEntity(context)).rejects.toThrow(InvalidRequestError)
      await expect(deployEntity(context)).rejects.toThrow(`Entity file "${entityId}" is missing from the request.`)
    })
  })

  describe('when the entity file is not valid JSON', () => {
    let context: DeployContext

    beforeEach(() => {
      context = createContext(entityId, { [entityId]: makeFile(Buffer.from('this is not json')) })
    })

    it('should reject with an InvalidRequestError instead of crashing', async () => {
      await expect(deployEntity(context)).rejects.toThrow(InvalidRequestError)
      await expect(deployEntity(context)).rejects.toThrow('The entity file is not valid JSON.')
    })
  })
})
