import {
  DeploymentProcessingStage,
  DeploymentToValidate,
  IDeploymentProcessingComponent,
  Validation,
  ValidationResult,
  Validator,
  ValidatorComponents
} from '../../types'
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

/** Times a single-call validation as one item of the given processing stage. */
function trackValidation(
  components: Pick<ValidatorComponents, 'deploymentProcessing'>,
  stage: DeploymentProcessingStage,
  validation: Validation
): Validation {
  return (deployment) =>
    components.deploymentProcessing.trackStage(stage, 1, () => Promise.resolve(validation(deployment)))
}

/** Banned names plus, unless skipped, the deployment permission, timed as `authorization` around `permission`. */
function createAuthorizeScene(
  components: ValidatorComponents,
  options?: { skipPermissionCheck?: boolean }
): Validation {
  const validations: Validation[] = [createValidateBannedNames(components)]
  if (!options?.skipPermissionCheck) {
    validations.push(trackValidation(components, 'permission', createValidateDeploymentPermission(components)))
  }
  return trackValidation(components, 'authorization', validateAll(validations))
}

export function createBeforeStorageValidateFns(components: ValidatorComponents): Validation[] {
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
        createValidateSceneDimensions(components),
        createAuthorizeScene(components),
        validateMiniMapImages,
        validateSkyboxTextures,
        validateThumbnail
      ])
    )
  ]
}

// Times only files still to hash: a second pass over memoized hashes would add a near-zero sample.
function trackHashing<T>(
  deploymentProcessing: IDeploymentProcessingComponent,
  deployment: DeploymentToValidate,
  operation: () => Promise<T>
): Promise<T> {
  const unhashed = Array.from(deployment.files.values()).filter((file) => !file.isHashed?.()).length
  return unhashed ? deploymentProcessing.trackStage('hash', unhashed, operation) : operation()
}

export function createAfterStorageValidateFns(components: ValidatorComponents): Validation[] {
  const { deploymentProcessing } = components
  return [
    async (deployment) =>
      trackHashing(deploymentProcessing, deployment, () =>
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
    validateBaseEntity,
    validateSupportedEntityType,
    validateIfTypeMatches(EntityType.SCENE, createValidateFileCount(components)),
    validateEntityId,
    validateAuthChain,
    validateSigner,
    validateSignature,
    createValidateDeploymentTtl(components)
  ]
}

// Scene structural validations that only inspect the entity / its declared content (no stored bytes).
// Runs in the staging path so #514's relative-path thumbnail check and the other structural checks apply
// to every partial request, not just at finalize.
function sceneStructuralValidations(components: ValidatorComponents): Validation[] {
  return [
    validateSceneEntity,
    validateDeprecatedConfig,
    createValidateParcelCoordinates(components),
    createValidateScenePointers(components),
    createValidateSceneDimensions(components),
    validateMiniMapImages,
    validateSkyboxTextures,
    validateThumbnail
    // validateSdkVersion(components) TODO re-enable (and test) once SDK7 is ready
  ]
}

/**
 * The validations a partial (staging) scene deployment must pass on every request, before all of its
 * content is necessarily present. Excludes `validateNoMissingFiles` (content completeness) and
 * `createValidateSize` (needs every file present; the scene-deployments component runs a cumulative
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
  const { deploymentProcessing } = components
  // The permission check is the slow, external call of the staging path. Resume batches of an upload
  // that already holds a pending record skip it (see Validator.validateStaging docs) so each batch of a
  // multi-request upload doesn't repeat it; the first request and the finalize step always run it.
  const sceneValidations = [...sceneStructuralValidations(components), createAuthorizeScene(components, options)]
  return [
    validateAll([
      ...commonValidations(components),
      (deployment) =>
        trackHashing(deploymentProcessing, deployment, () =>
          validateUploadedFiles(deployment, deploymentProcessing.hashConcurrency, deployment.signal, (operation) =>
            deploymentProcessing.trackWorker('hash', operation)
          )
        )
    ]),
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
      return runValidations(createStagingValidateFns(components, options), deployment, true)
    }
  }
}
