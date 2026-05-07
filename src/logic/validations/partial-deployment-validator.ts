import {
  IPartialDeploymentValidator,
  PARTIAL_DEPLOYMENT_DEFAULT_FILE_LIMIT_BYTES,
  ValidationResult,
  Validator,
  ValidatorComponents
} from '../../types'
import { createValidator } from './validator'

/**
 * Wraps the existing v1 Validator. preflight runs at init (no file bytes yet);
 * final runs at finalize (full validation including auth-chain). Both delegate
 * to the same v1 validator — the distinction is *when*, not *what*.
 */
export function createPartialDeploymentValidator(components: ValidatorComponents): IPartialDeploymentValidator {
  const v1Validator: Validator = createValidator(components)

  return {
    async preflight(input): Promise<ValidationResult> {
      // Reject oversized individual files before accepting any blobs.
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

      return v1Validator.validate({
        entity: input.entity,
        files: new Map([[input.entity.id, input.entityRaw]]),
        authChain: input.authChain,
        contentHashesInStorage: input.contentHashesInStorage
      })
    },

    async final(deployment): Promise<ValidationResult> {
      return v1Validator.validate(deployment)
    }
  }
}
