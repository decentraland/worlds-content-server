import { AppComponents, Validator } from '../types'
import { AuthChain, Entity, EthAddress, IPFSv2 } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'
import { Authenticator } from '@dcl/crypto'
import { hashV1 } from '@dcl/hashing'

const maxSizeInMB = 15

export type ValidationResult = {
  ok: () => boolean
  errors: string[]
}

export const createValidator = (
  components: Pick<AppComponents, 'config' | 'ethereumProvider' | 'storage'>
): Validator => {
  const validateFiles = async (
    entity: Entity,
    uploadedFiles: Map<string, Uint8Array>,
    contentHashesInStorage: Map<string, boolean>
  ): Promise<ValidationResult> => {
    const errors: string[] = []

    // validate all files are part of the entity
    for (const hash in uploadedFiles) {
      // detect extra file
      if (!entity.content!.some(($) => $.hash == hash) && hash !== entity.id) {
        errors.push(`Extra file detected ${hash}`)
      }
      // only new hashes
      if (!IPFSv2.validate(hash)) {
        errors.push(`Only CIDv1 are allowed for content files: ${hash}`)
      }
      // hash the file
      if ((await hashV1(uploadedFiles.get(hash)!)) !== hash) {
        errors.push(`The hashed file doesn't match the provided content: ${hash}`)
      }
    }

    // then ensure that all missing files are uploaded
    for (const file of entity.content!) {
      const isFilePresent = uploadedFiles.has(file.hash) || contentHashesInStorage.get(file.hash)
      if (!isFilePresent) {
        errors.push(`The file ${file.hash} (${file.file}) is neither present in the storage or in the provided entity`)
      }
    }

    return {
      ok: () => errors.length === 0,
      errors
    }
  }
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

  const validateEntityId = async (entityId: string, entityRaw: string): Promise<ValidationResult> => {
    const result = (await hashV1(stringToUtf8Bytes(entityRaw))) === entityId
    return {
      ok: () => result,
      errors: !result ? ['Invalid entity hash'] : []
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

  const validateDeployment = async (
    entity: Entity,
    entityRaw: string,
    authChain: AuthChain,
    uploadedFiles: Map<string, Uint8Array>,
    contentHashesInStorage: Map<string, boolean>
  ): Promise<ValidationResult> => {
    {
      const validationResult = await validateEntity(entity)
      if (!validationResult.ok()) {
        return validationResult
      }
    }

    {
      const validationResult = await validateAuthChain(authChain)
      if (!validationResult.ok()) {
        return validationResult
      }
    }

    {
      const validationResult = await validateSigner(authChain[0].payload)
      if (!validationResult.ok()) {
        return validationResult
      }
    }

    {
      const validationResult = await validateSignature(entity.id, authChain, 10)
      if (!validationResult.ok()) {
        return validationResult
      }
    }

    {
      const validationResult = await validateEntityId(entity.id, entityRaw)
      if (!validationResult.ok()) {
        return validationResult
      }
    }

    {
      const validationResult = await validateFiles(entity, uploadedFiles, contentHashesInStorage)
      if (!validationResult.ok()) {
        return validationResult
      }
    }

    {
      const validationResult = await validateSize(entity, uploadedFiles)
      if (!validationResult.ok()) {
        return validationResult
      }
    }

    return {
      ok: () => true,
      errors: []
    }
  }

  return {
    validateDeployment,
    validateAuthChain,
    validateEntity,
    validateEntityId,
    validateFiles,
    validateSignature,
    validateSigner,
    validateSize
  }
}
