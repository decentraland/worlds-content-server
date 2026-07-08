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

// Common validations that don't depend on the full content set being present (run in both phases).
// File validation is added by each phase separately: the full path uses the combined `validateFiles`
// (uploaded + no-missing, errors merged), while staging uses only `validateUploadedFiles`.
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

// Scene structural validations that only inspect the entity / its declared content (run in both phases).
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

export function createValidateFns(components: ValidatorComponents): Validation[] {
  return [
    // Common validations to all entity types
    validateAll([...commonValidations(components), validateFiles, validateSupportedEntityType]),

    // Scene entity validations
    validateIfTypeMatches(
      EntityType.SCENE,
      validateAll([
        ...sceneStructuralValidations(components),
        createValidateSize(components), // Slow
        createValidateDeploymentPermission(components) // Slow
      ])
    )

    // Other entity validations will go here ...
  ]
}

/**
 * The validations a partial (staging) scene deployment must pass on every request, before all of its
 * content is necessarily present. Excludes `validateNoMissingFiles` (content completeness) and
 * `createValidateSize` (needs every file present; the partial-deployments component runs a cumulative
 * size check instead). Still runs the deployment-permission check so staging is fully authorized.
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

async function runValidations(validations: Validation[], deployment: DeploymentToValidate): Promise<ValidationResult> {
  for (const validation of validations) {
    const result = await validation(deployment)
    if (!result.ok()) {
      return result
    }
  }
  return OK
}

export const createValidator = (components: ValidatorComponents): Validator => ({
  async validate(deployment: DeploymentToValidate): Promise<ValidationResult> {
    return runValidations(createValidateFns(components), deployment)
  },
  async validateStaging(
    deployment: DeploymentToValidate,
    options?: { skipPermissionCheck?: boolean }
  ): Promise<ValidationResult> {
    return runValidations(createStagingValidateFns(components, options), deployment)
  }
})
