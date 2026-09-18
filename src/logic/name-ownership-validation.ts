import { IConfigComponent } from '@well-known-components/interfaces'

/**
 * Development/test-only escape hatch.
 *
 * When enabled, scene deployments do not require the signer to own the
 * configured world name. The signer is persisted as the world owner instead.
 * This is intentionally not present in `.env.default`: an unset value is
 * always treated as `false`, and production deployments must never enable it.
 *
 * WARNING: enabling this flag removes the production name-ownership boundary.
 * Any wallet with a valid auth chain can deploy under any name. Do not enable
 * it on a public or production Worlds Content Server.
 */
export const IGNORE_NAME_OWNERSHIP_VALIDATION = 'IGNORE_NAME_OWNERSHIP_VALIDATION'

export async function isNameOwnershipValidationIgnored(config: Pick<IConfigComponent, 'getString'>): Promise<boolean> {
  return (await config.getString(IGNORE_NAME_OWNERSHIP_VALIDATION)) === 'true'
}
