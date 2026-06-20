export type IDenyListComponent = {
  isWalletDenylisted: (identity: string) => Promise<boolean>
  isEntityDenylisted: (entityId: string) => Promise<boolean>
}
