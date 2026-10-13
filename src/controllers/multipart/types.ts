import busboy from 'busboy'
import { createWriteStream } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { IInFlightUploadBudget, InFlightUploadBudgetSnapshot } from '../../adapters/in-flight-upload-budget'

export type MultipartRejectionReason =
  | 'bytes'
  | 'timeout'
  | 'wire_size'
  | 'payload_size'
  | 'files'
  | 'storage'
  | 'invalid_multipart'

type MultipartTelemetryEventBase = {
  route: string
  actualBytes: number
  contentLengthPresent: boolean
  snapshot: InFlightUploadBudgetSnapshot
}

export type MultipartTelemetryEvent =
  | (MultipartTelemetryEventBase & { kind: 'completed' })
  | (MultipartTelemetryEventBase & { kind: 'rejected'; reason: MultipartRejectionReason })

export type MultipartBodyReceivedEvent = {
  route: string
  outcome: 'completed' | 'rejected'
  /** From request arrival (or parser entry when unstamped) until the body was parsed or rejected. */
  durationSeconds: number
}

export type MultipartCleanupErrorEvent = {
  route: string
  error: Error
  /** Zero for the initial cleanup, then one-based for background retries. */
  attempt: number
  /** Whether another retry is scheduled after this failure. */
  willRetry: boolean
}

export type MultipartFileSystem = {
  createWriteStream: typeof createWriteStream
  mkdtemp: typeof mkdtemp
  rm: typeof rm
}

export type MultipartParserOptions = {
  /** Maximum total bytes (across all files and fields) buffered before the request is rejected. */
  maxSizeInBytes?: number
  /** Maximum full multipart wire size, including boundaries and part headers. */
  maxWireSizeInBytes?: number
  /** Overrides for the busboy limits (count/size caps). Defaults to {@link DEFAULT_LIMITS}. */
  limits?: busboy.Limits
  /** Shared aggregate buffered-bytes budget across concurrent uploads. */
  inFlightUploadBudget: IInFlightUploadBudget
  /** Maximum time allowed to receive and parse the request body. */
  uploadTimeoutMs?: number
  /** Stable route label used by upload telemetry. */
  route?: string
  /** Receives completion and rejection events for logging and metrics. */
  onTelemetry?: (event: MultipartTelemetryEvent) => void
  /** Receives how long the body took to arrive, before the handler runs or once it is rejected. */
  onBodyReceived?: (event: MultipartBodyReceivedEvent) => void
  /** Receives temporary-directory cleanup failures for logging and metrics. */
  onCleanupError?: (event: MultipartCleanupErrorEvent) => void
  /** Filesystem operations used for temporary uploads. Defaults to Node's filesystem. */
  fileSystem?: MultipartFileSystem
  /** Delays for bounded background retries after a temporary-directory cleanup failure. */
  cleanupRetryDelaysMs?: readonly number[]
  /** Field names that may repeat to carry several values. Every other form name must be unique. */
  repeatableFields?: readonly string[]
}
