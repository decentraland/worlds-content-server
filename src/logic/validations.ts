import { AppComponents, Validator } from '../types'
import { AuthChain, Entity, EthAddress } from '@dcl/schemas'
import { HTTPProvider } from 'eth-connect'
import { Authenticator } from '@dcl/crypto'

const maxSizeInMB = 15

export type ValidationResult = {
  ok: () => boolean
  errors: string[]
}

export const createValidator = (
  components: Pick<AppComponents, 'config' | 'ethereumProvider' | 'logs' | 'storage'>
): Validator => {
  const logger = components.logs.getLogger('validator')

  const validateSize = async (entity: Entity, files: Map<string, Uint8Array>): Promise<ValidationResult> => {
    const errors: string[] = []
    const maxSizeInBytes = maxSizeInMB * 1024 * 1024

    try {
      const totalSize = await calculateDeploymentSize(components, entity, files)
      const sizePerPointer = totalSize / entity.pointers.length
      if (sizePerPointer > maxSizeInBytes) {
        errors.push(
          `The deployment is too big. The maximum allowed size per pointer is ${maxSizeInMB} MB for scenes. You can upload up to ${
            entity.pointers.length * maxSizeInBytes
          } bytes but you tried to upload ${totalSize}.`
        )
      }
    } catch (e: any) {
      errors.push(e.message)
    }

    return {
      ok: () => errors.length === 0,
      errors
    }
  }

  const calculateDeploymentSize = async (
    { storage }: Pick<AppComponents, 'storage'>,
    entity: Entity,
    files: Map<string, Uint8Array>
  ): Promise<number> => {
    const fetchContentFileSize = async (hash: string): Promise<number> => {
      const content = await storage.retrieve(hash)
      if (!content) {
        throw Error(`Couldn't fetch content file with hash ${hash}`)
      }

      // Empty files are retrieved with size: null in aws-sdk
      return content.size || 0
    }

    let totalSize = 0
    for (const hash of new Set(entity.content?.map((item) => item.hash) ?? [])) {
      const uploadedFile = files.get(hash)
      if (uploadedFile) {
        totalSize += uploadedFile.byteLength
      } else {
        const contentSize = await fetchContentFileSize(hash)
        totalSize += contentSize
      }
    }
    return totalSize
  }

  const validateEntity = (entity: Entity): ValidationResult => {
    const result = Entity.validate(entity)
    return {
      ok: () => result,
      errors: Entity.validate.errors?.map((error) => error.message || '') || []
    }
  }

  const validateAuthChain = (authChain: AuthChain): ValidationResult => {
    const result = AuthChain.validate(authChain)
    if (!result) {
      console.dir(authChain)
      console.dir(AuthChain.validate.errors)
    }
    return {
      ok: () => result,
      errors: AuthChain.validate.errors?.map((error) => error.message || '') || []
    }
  }

  const validateSigner = (signer: string): ValidationResult => {
    const result = EthAddress.validate(signer)
    return {
      ok: () => result,
      errors: EthAddress.validate.errors?.map((error) => error.message || '') || []
    }
  }

  const validateSignature = async (
    entityId: string,
    authChain: AuthChain,
    dateToValidateExpirationInMillis?: number
  ): Promise<ValidationResult> => {
    const result = await Authenticator.validateSignature(
      entityId,
      authChain,
      components.ethereumProvider,
      dateToValidateExpirationInMillis
    )
    return {
      ok: () => result.ok,
      errors: result.message ? [result.message] : []
    }
  }

  return {
    validateEntity,
    validateAuthChain,
    validateSignature,
    validateSigner,
    validateSize
  }
}
