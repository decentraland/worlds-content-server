import { DeploymentToValidate, Validation, ValidationResult, Validator, ValidatorComponents } from '../../types'
import {
  createValidateDeploymentTtl,
  validateAuthChain,
  validateBaseEntity,
  validateEntityId,
  validateFiles,
  validateSignature,
  validateSigner,
  validateSupportedEntityType
} from './common'
import {
  createValidateBannedNames,
  createValidateDeploymentPermission,
  createValidateFileCount,
  createValidateParcelCoordinates,
  createValidateSceneDimensions,
  createValidateScenePointers,
  createValidateSize,
  validateDeprecatedConfig,
  validateMiniMapImages,
  validateSceneEntity,
  validateSkyboxTextures,
  validateThumbnail
} from './scene'
import { OK, validateAll, validateIfTypeMatches } from './utils'
import { EntityType } from '@dcl/schemas'

export function createBeforeStorageValidateFns(components: ValidatorComponents): Validation[] {
  return [
    validateBaseEntity,
    validateSupportedEntityType,
    validateIfTypeMatches(EntityType.SCENE, createValidateFileCount(components)),
    validateAuthChain,
    validateSigner,
    createValidateDeploymentTtl(components),
    validateEntityId,
    validateSignature
  ]
}

export function createAfterStorageValidateFns(components: ValidatorComponents): Validation[] {
  const { deploymentProcessing } = components
  return [
    async (deployment) =>
      deploymentProcessing.trackStage('hash', deployment.files.size, () =>
        validateFiles(deployment, deploymentProcessing.hashConcurrency, deployment.signal, (operation) =>
          deploymentProcessing.trackWorker('hash', operation)
        )
      ),
    validateIfTypeMatches(
      EntityType.SCENE,
      validateAll([
        validateSceneEntity,
        validateDeprecatedConfig,
        createValidateParcelCoordinates(components),
        createValidateScenePointers(components),
        createValidateSceneDimensions(components),
        validateMiniMapImages,
        validateSkyboxTextures,
        validateThumbnail,
        createValidateBannedNames(components),
        // validateSdkVersion(components) TODO re-enable (and test) once SDK7 is ready
        createValidateSize(components), // Slow
        createValidateDeploymentPermission(components) // Slow
      ])
    )
  ]
}

async function runValidations(validations: Validation[], deployment: DeploymentToValidate): Promise<ValidationResult> {
  for (const validation of validations) {
    deployment.signal?.throwIfAborted()
    const result = await validation(deployment)
    deployment.signal?.throwIfAborted()
    if (!result.ok()) {
      return result
    }
  }

  return OK
}

/**
 * Creates the deployment validator with an explicit pre-storage phase so untrusted entities are
 * structurally and cryptographically checked before they can trigger external storage requests.
 *
 * @param components Dependencies used by deployment validations.
 * @returns The complete validator and its pre-/post-storage phases.
 */
export const createValidator = (components: ValidatorComponents): Validator => {
  const beforeStorageValidations = createBeforeStorageValidateFns(components)
  const afterStorageValidations = createAfterStorageValidateFns(components)

  return {
    async validateBeforeStorage(deployment: DeploymentToValidate): Promise<ValidationResult> {
      return runValidations(beforeStorageValidations, deployment)
    },
    async validateAfterStorage(deployment: DeploymentToValidate): Promise<ValidationResult> {
      return runValidations(afterStorageValidations, deployment)
    },
    async validate(deployment: DeploymentToValidate): Promise<ValidationResult> {
      const beforeStorageResult = await runValidations(beforeStorageValidations, deployment)
      if (!beforeStorageResult.ok()) {
        return beforeStorageResult
      }

      return runValidations(afterStorageValidations, deployment)
    }
  }
}
