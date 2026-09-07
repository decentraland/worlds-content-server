import { readFileSync } from 'fs'
import * as path from 'path'

/**
 * Reader for the iteration-2 contract fixture pack.
 *
 * The JSON files under `http/` are verbatim copies of
 * `archipelago-workers/docs/contracts/iteration-2/http/*.json`; their sha256 must keep matching the
 * pack's `manifest.json`. Never edit a copy — if a fixture is wrong, the contract is wrong.
 */
export type HttpGolden<T = any> = {
  request: string
  note?: string
  status: number
  body: T
}

export type PulseRealmsBody = {
  realms: { name: string; peers: number; clusters: number }[]
  lastUpdated: string
}

export type PulsePeerBody = {
  ok: boolean
  peer: {
    id: string
    address: string
    lastPing: number
    parcel: [number, number]
    position: [number, number, number]
    realm: string
  } | null
}

export type PulsePeersBody = {
  ok: boolean
  peers: NonNullable<PulsePeerBody['peer']>[]
}

export function loadHttpGolden<T = any>(name: string): HttpGolden<T> {
  return JSON.parse(readFileSync(path.resolve(__dirname, 'http', `${name}.json`), 'utf-8'))
}
