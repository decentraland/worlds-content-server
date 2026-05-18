import {
  IPartialDeploymentValidator,
  PARTIAL_DEPLOYMENT_DEFAULT_FILE_LIMIT_BYTES,
  ValidationResult,
  Validator,
  ValidatorComponents
} from '../../types'
import { createCommonValidations, createValidator } from './validator'
import { OK } from './utils'

/**
 * preflight runs at init time and only executes validations that don't require
 * content file bytes (signer, entity well-formedness, scene metadata, name
 * permission). final runs at finalize and delegates to the full v1 validator.
 */
export function createPartialDeploymentValidator(components: ValidatorComponents): IPartialDeploymentValidator {
  const v1Validator: Validator = createValidator(components)
  const preflightValidations = createCommonValidations(components)

  return {
    async preflight(input): Promise<ValidationResult> {
      const oversized: string[] = []
      for (const [hash, size] of Object.entries(input.fileSizesManifest)) {
        if (size > PARTIAL_DEPLOYMENT_DEFAULT_FILE_LIMIT_BYTES) {
          oversized.push(`${hash} (${size} bytes)`)
        }
      }
      if (oversized.length > 0) {
        const errors = [
          `Files exceed per-file size limit (${PARTIAL_DEPLOYMENT_DEFAULT_FILE_LIMIT_BYTES} bytes): ${oversized.join(', ')}`
        ]
        return { ok: () => false, errors }
      }

      const deployment = {
        entity: input.entity,
        files: new Map([[input.entity.id, input.entityRaw]]),
        authChain: input.authChain,
        contentHashesInStorage: input.contentHashesInStorage
      }
      for (const validation of preflightValidations) {
        const result = await validation(deployment)
        if (!result.ok()) return result
      }
      return OK
    },

    async final(deployment): Promise<ValidationResult> {
      return v1Validator.validate(deployment)
    }
  }
}
