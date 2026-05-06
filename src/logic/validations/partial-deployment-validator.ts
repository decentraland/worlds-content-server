import { IPartialDeploymentValidator, ValidationResult, Validator, ValidatorComponents } from '../../types'
import { createValidator } from './validator'

/**
 * Wraps the existing v1 Validator. preflight runs at init (no file bytes yet);
 * final runs at finalize (full validation including auth-chain). Both delegate
 * to the same v1 validator — the distinction is *when*, not *what*.
 */
export function createPartialDeploymentValidator(
  components: ValidatorComponents
): IPartialDeploymentValidator {
  const v1Validator: Validator = createValidator(components)

  return {
    async preflight(input): Promise<ValidationResult> {
      return v1Validator.validate({
        entity: input.entity,
        files: new Map(), // no file bytes available at init time
        authChain: input.authChain,
        contentHashesInStorage: input.contentHashesInStorage
      })
    },

    async final(deployment): Promise<ValidationResult> {
      return v1Validator.validate(deployment)
    }
  }
}
