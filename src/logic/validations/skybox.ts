import { DeploymentToValidate, Validation, ValidationResult } from '../../types'
import { Skybox } from '@dcl/schemas'
import { createValidationResult, OK } from './utils'

export const validateSkyboxEntity: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  if (!Skybox.validate(deployment.entity.metadata)) {
    return createValidationResult(Skybox.validate.errors?.map((error) => error.message || '') || [])
  }

  return OK
}

export const validatePointer: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  if (deployment.entity.pointers.length !== 1) {
    return createValidationResult([`Skybox should have exactly one pointer.`])
  }
  if (!/^urn:decentraland:skybox:[a-zA-Z0-9-]+$/.test(deployment.entity.pointers[0])) {
    return createValidationResult([
      `Skybox pointer should have 4 parts, start "urn:decentraland.skybox:" and end with a name formed by letters, numbers and "-".`
    ])
  }

  return OK
}
