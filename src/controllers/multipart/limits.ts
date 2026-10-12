import busboy from 'busboy'

const MB = 1024 * 1024

const DEFAULT_MAX_FILES = 10_000
export const DEFAULT_LIMITS: busboy.Limits = {
  fieldNameSize: 200,
  fieldSize: MB,
  fields: 100,
  files: DEFAULT_MAX_FILES,
  parts: DEFAULT_MAX_FILES + 100
}

/** Longest auth chain a deployment may carry, as on Catalyst (real chains have 2-3 links). */
export const MAX_DEPLOYMENT_AUTH_CHAIN_LINKS = 10
/** Non-file fields of a deployment: `entityId`, `partial` and `authChain[i][type|payload|signature]`. */
export const MAX_DEPLOYMENT_FIELDS = 2 + 3 * MAX_DEPLOYMENT_AUTH_CHAIN_LINKS
/** Largest legitimate value is an EIP-1654 signature of a few KiB; ephemeral payloads are ~120 bytes. */
export const MAX_DEPLOYMENT_FIELD_SIZE_IN_BYTES = 32 * 1024
/** Field caps for POST /entities, so a request holds at most 32 x 32 KiB = 1 MiB of fields in memory. */
export const DEPLOYMENT_FIELD_LIMITS: busboy.Limits = {
  fields: MAX_DEPLOYMENT_FIELDS,
  fieldSize: MAX_DEPLOYMENT_FIELD_SIZE_IN_BYTES,
  parts: DEFAULT_MAX_FILES + MAX_DEPLOYMENT_FIELDS
}

export const DEFAULT_REJECTED_UPLOAD_DRAIN_TIMEOUT_MS = 5 * 1000
export const DEFAULT_MULTIPART_WIRE_OVERHEAD_IN_BYTES = 10 * MB
export const DEFAULT_MULTIPART_CLEANUP_RETRY_DELAYS_MS = [100, 1_000, 5_000] as const
export const MAX_WORLD_SETTINGS_UPLOAD_SIZE_IN_BYTES = 2 * MB
