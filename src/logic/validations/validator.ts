import { DeploymentToValidate, Validation, ValidationResult, Validator, ValidatorComponents } from '../../types'
import {
  createValidateDeploymentTtl,
  validateAuthChain,
  validateBaseEntity,
  validateEntityId,
  validateFiles,
  validateSignature,
  validateSigner,
  validateSupportedEntityType,
  validateUploadedFiles
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

// Content-independent validations (structure, crypto, freshness) that don't require any content set to
// be present. Shared by the staging path so a partial (multi-request) upload is fully checked on every
// request; the full-deploy path inlines the equivalent list in `createBeforeStorageValidateFns`.
function commonValidations(components: ValidatorComponents): Validation[] {
  return [
    validateEntityId,
    validateBaseEntity,
    validateAuthChain,
    validateSigner,
    validateSignature,
    createValidateDeploymentTtl(components)
  ]
}

// Scene structural validations that only inspect the entity / its declared content (no stored bytes).
// Runs in the staging path so #514's relative-path thumbnail check and the other structural checks apply
// to every partial request, not just at finalize. A fresh array per call so staging can append to it.
function sceneStructuralValidations(components: ValidatorComponents): Validation[] {
  return [
    validateSceneEntity,
    validateDeprecatedConfig,
    createValidateParcelCoordinates(components),
    createValidateScenePointers(components),
    createValidateSceneDimensions(components),
    createValidateFileCount(components),
    validateMiniMapImages,
    validateSkyboxTextures,
    validateThumbnail,
    createValidateBannedNames(components)
    // validateSdkVersion(components) TODO re-enable (and test) once SDK7 is ready
  ]
}

/**
 * The validations a partial (staging) scene deployment must pass on every request, before all of its
 * content is necessarily present. Excludes `validateNoMissingFiles` (content completeness) and
 * `createValidateSize` (needs every file present; the partial-deployments component runs a cumulative
 * size check instead). Uses `validateUploadedFiles` — the hash/CIDv1 check on the bytes uploaded this
 * request — rather than the full `validateFiles`.
 *
 * `skipPermissionCheck` skips the (slow, external) deployment-permission check. Safe only for a resume
 * batch that already holds a non-expired pending record: creating that record required passing the
 * permission check, uploaded bytes are hash-verified against the staged manifest, and finalize re-runs
 * the full validation (including permission) before anything goes live.
 */
export function createStagingValidateFns(
  components: ValidatorComponents,
  options?: { skipPermissionCheck?: boolean }
): Validation[] {
  const sceneValidations = sceneStructuralValidations(components)
  // The permission check is the slow, external call of the staging path. Resume batches of an upload
  // that already holds a pending record skip it (see Validator.validateStaging docs) so each batch of a
  // multi-request upload doesn't repeat it; the first request and the finalize step always run it.
  if (!options?.skipPermissionCheck) {
    sceneValidations.push(createValidateDeploymentPermission(components))
  }
  return [
    validateAll([...commonValidations(components), validateUploadedFiles, validateSupportedEntityType]),
    validateIfTypeMatches(EntityType.SCENE, validateAll(sceneValidations))
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
 * structurally and cryptographically checked before they can trigger external storage requests, plus a
 * staging phase for partial (multi-request) uploads.
 *
 * @param components Dependencies used by deployment validations.
 * @returns The complete validator and its pre-/post-storage and staging phases.
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
    },
    async validateStaging(
      deployment: DeploymentToValidate,
      options?: { skipPermissionCheck?: boolean }
    ): Promise<ValidationResult> {
      return runValidations(createStagingValidateFns(components, options), deployment)
    }
  }
}
