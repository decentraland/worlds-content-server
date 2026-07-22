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
import { raceWithSignal } from '../concurrency'

export function createBeforeStorageValidateFns(components: ValidatorComponents): Validation[] {
  const authorizeScene = validateAll([
    createValidateBannedNames(components),
    createValidateDeploymentPermission(components)
  ])
  return [
    validateBaseEntity,
    validateSupportedEntityType,
    validateIfTypeMatches(EntityType.SCENE, createValidateFileCount(components)),
    validateAuthChain,
    validateSigner,
    createValidateDeploymentTtl(components),
    validateEntityId,
    validateSignature,
    validateIfTypeMatches(
      EntityType.SCENE,
      validateAll([
        validateSceneEntity,
        validateDeprecatedConfig,
        createValidateParcelCoordinates(components),
        createValidateScenePointers(components),
        async (deployment) =>
          components.deploymentProcessing.trackStage('authorization', 1, () =>
            Promise.resolve(authorizeScene(deployment))
          ),
        createValidateSceneDimensions(components),
        validateMiniMapImages,
        validateSkyboxTextures,
        validateThumbnail
      ])
    )
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
      // validateSdkVersion(components) TODO re-enable (and test) once SDK7 is ready
      createValidateSize(components)
    )
  ]
}

async function runValidations(
  validations: Validation[],
  deployment: DeploymentToValidate,
  returnImmediatelyOnAbort: boolean = false
): Promise<ValidationResult> {
  for (const validation of validations) {
    deployment.signal?.throwIfAborted()
    const validationResult = Promise.resolve(validation(deployment))
    const result = await (returnImmediatelyOnAbort
      ? raceWithSignal(validationResult, deployment.signal)
      : validationResult)
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

  async function runAfterStorageValidations(deployment: DeploymentToValidate): Promise<ValidationResult> {
    const hashResult = await runValidations(afterStorageValidations.slice(0, 1), deployment)
    return hashResult.ok() ? runValidations(afterStorageValidations.slice(1), deployment, true) : hashResult
  }

  return {
    async validateBeforeStorage(deployment: DeploymentToValidate): Promise<ValidationResult> {
      return runValidations(beforeStorageValidations, deployment, true)
    },
    async validateAfterStorage(deployment: DeploymentToValidate): Promise<ValidationResult> {
      return runAfterStorageValidations(deployment)
    },
    async validate(deployment: DeploymentToValidate): Promise<ValidationResult> {
      const beforeStorageResult = await runValidations(beforeStorageValidations, deployment, true)
      if (!beforeStorageResult.ok()) {
        return beforeStorageResult
      }

      return runAfterStorageValidations(deployment)
    }
  }
}
