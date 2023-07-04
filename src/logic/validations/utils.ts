import { DeploymentToValidate, Validation, ValidationResult } from '../../types'
import { EntityType } from '@dcl/schemas'

export const createValidationResult = (errors: string[]) => {
  return {
    ok: () => errors.length === 0,
    errors
  }
}

export const OK = createValidationResult([])

export function validateIfConditionMet(
  condition: (deployment: DeploymentToValidate) => boolean | Promise<boolean>,
  validation: Validation
): Validation {
  return async (deployment: DeploymentToValidate) => {
    const conditionIsMet = await condition(deployment)
    if (conditionIsMet) {
      return validation(deployment)
    }
    return OK
  }
}

export function validateIfTypeMatches(entityType: EntityType, validation: Validation) {
  return validateIfConditionMet((deployment) => deployment.entity.type === entityType, validation)
}

export function validateAll(allValidations: Validation[]): Validation {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    for (const validate of allValidations) {
      const response = await validate(deployment)
      if (!response.ok()) {
        return response
      }
    }

    return OK
  }
}
