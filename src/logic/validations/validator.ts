import { DeploymentToValidate, Validation, ValidationResult, Validator, ValidatorComponents } from '../../types'
import {
  validateAuthChain,
  validateBaseEntity,
  validateDeploymentTtl,
  validateEntityId,
  validateFiles,
  validateSignature,
  validateSigner
} from './common'
import {
  validateDeploymentPermission,
  validateMiniMapImages,
  validateSceneDimensions,
  validateSceneEntity,
  validateSize,
  validateSkyboxTextures,
  validateThumbnail
} from './scene'
import { OK } from './utils'

export const commonValidations: Validation[] = [
  validateEntityId,
  validateBaseEntity,
  validateAuthChain,
  validateSigner,
  validateSignature,
  validateDeploymentTtl,
  validateFiles
]

const sceneValidations: Validation[] = [
  validateSceneEntity,
  validateSceneDimensions,
  validateMiniMapImages,
  validateSkyboxTextures,
  validateThumbnail,
  // validateSdkVersion TODO re-enable (and test) once SDK7 is ready
  validateSize, // Slow
  validateDeploymentPermission // Slow
]

const allValidations: Validation[] = [...commonValidations, ...sceneValidations]

export const createValidator = (components: ValidatorComponents): Validator => ({
  async validate(deployment: DeploymentToValidate): Promise<ValidationResult> {
    for (const validate of allValidations) {
      const result = await validate(components, deployment)
      if (!result.ok()) {
        return result
      }
    }

    return OK
  }
})
