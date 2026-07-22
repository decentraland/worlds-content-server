import { Whitelist } from '../../types'

/**
 * Provides the worlds whitelist (per-name overrides for parcel/size limits, SDK6 allowance and
 * quota exemptions). The value is fetched from a remote source and cached for a short period. On
 * a fetch failure it keeps serving the last known value; it only rejects when there is no cached
 * value at all, so callers decide how to degrade (e.g. fall back to hard limits, or skip work)
 * rather than silently proceeding with an empty whitelist.
 */
export interface IWhitelistComponent {
  /**
   * Returns the current whitelist, served from cache when fresh or stale-on-error when a refresh
   * fails but a previous value exists.
   *
   * @throws when the whitelist has never been fetched successfully and the source is unavailable
   */
  get(): Promise<Whitelist>
}
