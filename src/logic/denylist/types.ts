/**
 * Component interface for checking if a wallet address is in the global denylist.
 */
export type IDenyListComponent = {
  /**
   * Checks if the given identity (wallet address) is in the global denylist.
   *
   * @param identity - The wallet address to check.
   * @returns True if the identity is denylisted, false otherwise.
   */
  isDenylisted: (identity: string) => Promise<boolean>
}
