import { DeploymentToValidate, Validation, ValidationResult, ValidatorComponents } from '../../types'
import { hashV1 } from '@dcl/hashing'
import { createValidationResult, OK } from './utils'
import { AuthChain, Entity, EntityType, EthAddress, IPFSv2 } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'

export const validateEntityId: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  const entityRaw = deployment.files.get(deployment.entity.id)
  if (!entityRaw) {
    return createValidationResult(['Entity not found in files.'])
  }

  const result = (await hashV1(entityRaw)) === deployment.entity.id
  return createValidationResult(
    !result ? [`Invalid entity hash: expected ${await hashV1(entityRaw)} but got ${deployment.entity.id}`] : []
  )
}

export const validateBaseEntity: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  if (!Entity.validate(deployment.entity)) {
    return createValidationResult(Entity.validate.errors?.map((error) => error.message || '') || [])
  }

  return OK
}

export function createValidateDeploymentTtl(components: Pick<ValidatorComponents, 'config'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const ttl = Date.now() - deployment.entity.timestamp
    const maxTtl = (await components.config.getNumber('DEPLOYMENT_TTL')) || 300_000
    if (ttl > maxTtl) {
      return createValidationResult([
        `Deployment was created ${ttl / 1000} secs ago. Max allowed: ${maxTtl / 1000} secs.`
      ])
    }
    return OK
  }
}

export const validateAuthChain: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  if (!AuthChain.validate(deployment.authChain)) {
    return createValidationResult(AuthChain.validate.errors?.map((error) => error.message || '') || [])
  }

  return OK
}

export const validateSigner: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  const signer = deployment.authChain[0].payload
  if (!EthAddress.validate(signer)) {
    return createValidationResult([`Invalid signer: ${signer}`])
  }

  return OK
}

export const validateSignature: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  const result = await Authenticator.validateSignature(deployment.entity.id, deployment.authChain, null, 10)

  return createValidationResult(result.message ? [result.message] : [])
}

export const validateFiles: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  const errors: string[] = []

  // validate all files are part of the entity
  for (const [hash] of deployment.files) {
    // detect extra file
    if (!deployment.entity.content!.some(($) => $.hash === hash) && hash !== deployment.entity.id) {
      errors.push(`Extra file detected ${hash}`)
    }
    // only new hashes
    if (!IPFSv2.validate(hash)) {
      errors.push(`Only CIDv1 are allowed for content files: ${hash}`)
    }
    // hash the file
    if ((await hashV1(deployment.files.get(hash)!)) !== hash) {
      errors.push(`The hashed file doesn't match the provided content: ${hash}`)
    }
  }

  // then ensure that all missing files are uploaded
  for (const file of deployment.entity.content!) {
    const isFilePresent = deployment.files.has(file.hash) || deployment.contentHashesInStorage.get(file.hash)
    if (!isFilePresent) {
      errors.push(`The file ${file.hash} (${file.file}) is neither present in the storage or in the provided entity`)
    }
  }

  return createValidationResult(errors)
}

export const validateSupportedEntityType = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  switch (deployment.entity.type) {
    case EntityType.SCENE:
      return OK
  }
  return createValidationResult([`Entity type ${deployment.entity.type} is not supported.`])
}
