import { DeploymentToValidate, Validation, ValidationResult, ValidatorComponents } from '../../types'
import { hashV1 } from '@dcl/hashing'
import { createValidationResult, OK } from './utils'
import { AuthChain, Entity, EntityType, EthAddress, IPFSv2 } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'

export const validateEntityId: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  const entityFile = deployment.files.get(deployment.entity.id)
  if (!entityFile) {
    return createValidationResult(['Entity not found in files.'])
  }

  const actualHash = await hashV1(entityFile.getStream())
  return createValidationResult(
    actualHash !== deployment.entity.id
      ? [`Invalid entity hash: expected ${actualHash} but got ${deployment.entity.id}`]
      : []
  )
}

export const validateBaseEntity: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  if (!Entity.validate(deployment.entity)) {
    return createValidationResult(Entity.validate.errors?.map((error) => error.message || '') || [])
  }

  return OK
}

// Forward tolerance for entity timestamps (client clock skew). Deployment ordering is
// newest-timestamp-wins, so a far-future-dated entity would permanently "win" the parcels it occupies,
// blocking every honestly-dated deploy until it is manually undeployed. Mirrors catalyst's forward TTL.
const MAX_TIMESTAMP_FORWARD_TOLERANCE_MS = 15 * 60 * 1000 // 15 minutes

export function createValidateDeploymentTtl(components: Pick<ValidatorComponents, 'config'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    // A partial (multi-request) upload can span longer than the deployment TTL, so when a pending
    // upload exists the entity's freshness is measured against when the upload started
    // (pendingCreatedAt) rather than now. Full deploys have no pending row and anchor on Date.now().
    const anchor = deployment.pendingCreatedAt?.getTime() ?? Date.now()
    const ttl = anchor - deployment.entity.timestamp
    const maxTtl = (await components.config.getNumber('DEPLOYMENT_TTL')) || 300_000
    if (ttl > maxTtl) {
      return createValidationResult([
        `Deployment was created ${ttl / 1000} secs ago. Max allowed: ${maxTtl / 1000} secs.`
      ])
    }
    if (-ttl > MAX_TIMESTAMP_FORWARD_TOLERANCE_MS) {
      return createValidationResult([
        `Deployment timestamp is ${-ttl / 1000} secs in the future. Max allowed: ${MAX_TIMESTAMP_FORWARD_TOLERANCE_MS / 1000} secs.`
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
  const result = await Authenticator.validateSignature(deployment.entity.id, deployment.authChain, null, Date.now())

  return createValidationResult(result.message ? [result.message] : [])
}

/**
 * Validates the files uploaded in *this* request: each must be referenced by the entity (or be the
 * entity file), be a CIDv1, and hash to its declared key. Runs in both the full and staging validation
 * paths — it does not depend on the full content set being present.
 */
export const validateUploadedFiles: Validation = async (
  deployment: DeploymentToValidate
): Promise<ValidationResult> => {
  const errors: string[] = []

  for (const [hash] of deployment.files) {
    // detect extra file
    if (!deployment.entity.content!.some(($) => $.hash === hash) && hash !== deployment.entity.id) {
      errors.push(`Extra file detected ${hash}`)
    }
    // only new hashes
    if (!IPFSv2.validate(hash)) {
      errors.push(`Only CIDv1 are allowed for content files: ${hash}`)
    }
    // hash the file (streamed from disk so large files aren't loaded into memory)
    if ((await hashV1(deployment.files.get(hash)!.getStream())) !== hash) {
      errors.push(`The hashed file doesn't match the provided content: ${hash}`)
    }
  }

  return createValidationResult(errors)
}

/**
 * Validates that every file the entity references is present — either uploaded now or already stored.
 * Only meaningful once the full content set can be present, so it runs in the full validation path but
 * NOT while staging a partial deployment.
 */
export const validateNoMissingFiles: Validation = async (
  deployment: DeploymentToValidate
): Promise<ValidationResult> => {
  const errors: string[] = []

  for (const file of deployment.entity.content!) {
    const isFilePresent = deployment.files.has(file.hash) || deployment.contentHashesInStorage.get(file.hash)
    if (!isFilePresent) {
      errors.push(`The file ${file.hash} (${file.file}) is neither present in the storage or in the provided entity`)
    }
  }

  return createValidationResult(errors)
}

/**
 * Full-deployment file validation: runs the uploaded-file checks and the no-missing-files check and
 * returns their errors combined. Listing the two separately in `validateAll` would short-circuit on
 * the first failure and hide the missing-file errors behind uploaded-file errors — the original
 * `validateFiles` reported both together, which this preserves. Not used while staging a partial
 * deployment (completeness is intentionally not required there).
 */
export const validateFiles: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  const [uploaded, missing] = await Promise.all([validateUploadedFiles(deployment), validateNoMissingFiles(deployment)])
  return createValidationResult([...uploaded.errors, ...missing.errors])
}

export const validateSupportedEntityType = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  switch (deployment.entity.type) {
    case EntityType.SCENE:
      return OK
  }
  return createValidationResult([`Entity type ${deployment.entity.type} is not supported.`])
}
