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
  createValidateSceneDimensions,
  createValidateSize,
  validateDeprecatedConfig,
  validateMiniMapImages,
  validateSceneEntity,
  validateSkyboxTextures,
  validateThumbnail
} from './scene'
import { OK, validateAll, validateIfTypeMatches } from './utils'
import { EntityType } from '@dcl/schemas'

export function createValidateFns(components: ValidatorComponents): Validation[] {
  return [
    // Common validations to all entity types
    validateAll([
      validateEntityId,
      validateBaseEntity,
      validateAuthChain,
      validateSigner,
      validateSignature,
      createValidateDeploymentTtl(components),
      validateFiles,
      validateSupportedEntityType
    ]),

    // Scene entity validations
    validateIfTypeMatches(
      EntityType.SCENE,
      validateAll([
        validateSceneEntity,
        validateDeprecatedConfig,
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

    // Other entity validations will go here ...
  ]
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
