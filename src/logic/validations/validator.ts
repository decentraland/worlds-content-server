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

/**
 * Validations safe to run at partial-deployment init (preflight), when only the
 * entity raw is available and content file bytes have not yet been uploaded.
 * They depend on entity metadata, auth chain, or `files.get(entity.id)` only.
 */
export function createCommonValidations(components: ValidatorComponents): Validation[] {
  return [
    validateAll([
      validateEntityId,
      validateBaseEntity,
      validateAuthChain,
      validateSigner,
      validateSignature,
      createValidateDeploymentTtl(components),
      validateSupportedEntityType
    ]),

    validateIfTypeMatches(
      EntityType.SCENE,
      validateAll([
        validateSceneEntity,
        validateDeprecatedConfig,
        createValidateParcelCoordinates(components),
        createValidateScenePointers(components),
        createValidateSceneDimensions(components),
        createValidateFileCount(components),
        validateMiniMapImages,
        validateSkyboxTextures,
        validateThumbnail,
        createValidateBannedNames(components),
        // validateSdkVersion(components) TODO re-enable (and test) once SDK7 is ready
        createValidateDeploymentPermission(components) // Slow
      ])
    )
  ]
}

/**
 * Validations that require every content file to be present (uploaded or
 * already in storage). Only runnable at finalize.
 */
export function createFinalOnlyValidations(components: ValidatorComponents): Validation[] {
  return [validateFiles, validateIfTypeMatches(EntityType.SCENE, createValidateSize(components))]
}

export function createValidateFns(components: ValidatorComponents): Validation[] {
  return [...createCommonValidations(components), ...createFinalOnlyValidations(components)]
}

export const createValidator = (components: ValidatorComponents): Validator => ({
  async validate(deployment: DeploymentToValidate): Promise<ValidationResult> {
    const validations = createValidateFns(components)
    for (const validation of validations) {
      const result = await validation(deployment)
      if (!result.ok()) {
        return result
      }
    }

    return OK
  }
})
