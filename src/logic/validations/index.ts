import { DeploymentToValidate, ValidationResult, Validator, ValidatorComponents } from '../../types'
import { OK } from './utils'
import { allValidations } from './validator'

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
