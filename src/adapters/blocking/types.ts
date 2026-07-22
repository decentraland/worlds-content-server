import { EthAddress } from '@dcl/schemas'

/**
 * Owns the `blocked` table: the single home for deciding when a wallet should be
 * blocked or unblocked for exceeding its allowed storage space, and for emitting the
 * corresponding notifications. Every path that changes a wallet's used space (the
 * scheduled reconciliation job, deployments and undeployments) goes through this
 * component so the quota rules and the SNS events stay consistent.
 */
export interface IBlockingComponent {
  /**
   * Creates or refreshes a blocking record for the wallet when it is over its allowed
   * quota (discounting whitelisted worlds), publishing the "missing resources" / "access
   * restricted" notifications. No-op when the wallet is under quota.
   *
   * @param wallet - The wallet to evaluate
   * @returns true if a blocking record was created or refreshed, false otherwise
   */
  blockIfOverQuota(wallet: EthAddress): Promise<boolean>

  /**
   * Removes the wallet's blocking record when it is currently blocked and has dropped back
   * under its allowed quota (discounting whitelisted worlds), publishing the "access
   * restored" notification. Best-effort: it short-circuits cheaply when the wallet is not
   * blocked, and logs and returns false on any failure instead of throwing, so callers on
   * request paths can await it without risking the request outcome.
   *
   * @param wallet - The wallet to evaluate
   * @returns true if the wallet was unblocked, false otherwise
   */
  unblockIfUnderQuota(wallet: EthAddress): Promise<boolean>

  /**
   * Deletes blocking records that were not refreshed since `runStartedAt`, excluding the
   * wallets in `keepWallets` (used to protect wallets whose status could not be evaluated
   * in the current run). Publishes an "access restored" notification for each removed record.
   *
   * @param runStartedAt - The timestamp the reconciliation run started at
   * @param keepWallets - Wallets to exclude from deletion
   */
  collectStaleBlockingRecords(runStartedAt: Date, keepWallets: Set<string>): Promise<void>
}
