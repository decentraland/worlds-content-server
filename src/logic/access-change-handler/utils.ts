import { type AccessSetting, AccessType } from '../access/types'

export function secretChanged(prev: AccessSetting, current: AccessSetting): boolean {
  if (prev.type !== AccessType.SharedSecret || current.type !== AccessType.SharedSecret) return false
  return prev.secret !== current.secret
}

export function allowListChanged(prev: AccessSetting, current: AccessSetting): boolean {
  if (prev.type !== AccessType.AllowList || current.type !== AccessType.AllowList) return false

  const prevWallets = (prev.wallets || []).map((w) => w.toLowerCase()).sort()
  const currentWallets = (current.wallets || []).map((w) => w.toLowerCase()).sort()
  if (prevWallets.length !== currentWallets.length || prevWallets.some((w, i) => w !== currentWallets[i])) return true

  const prevCommunities = (prev.communities || []).slice().sort()
  const currentCommunities = (current.communities || []).slice().sort()
  return (
    prevCommunities.length !== currentCommunities.length || prevCommunities.some((c, i) => c !== currentCommunities[i])
  )
}
