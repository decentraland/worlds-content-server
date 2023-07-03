import { Validation } from '../../types'
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

export const commonValidations: Validation[] = [
  validateEntityId,
  validateBaseEntity,
  validateAuthChain,
  validateSigner,
  validateSignature,
  validateDeploymentTtl,
  validateFiles
]

const quickValidations: Validation[] = [
  validateSceneEntity,
  validateSceneDimensions,
  validateMiniMapImages,
  validateSkyboxTextures,
  validateThumbnail
  // validateSdkVersion TODO re-enable (and test) once SDK7 is ready
]

export const slowValidations: Validation[] = [validateSize, validateDeploymentPermission]

export const allValidations: Validation[] = [...commonValidations, ...quickValidations, ...slowValidations]
