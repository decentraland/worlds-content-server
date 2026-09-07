import { IConfigComponent } from '@well-known-components/interfaces'
import { IFetchComponent } from '@dcl/core-commons'
import { HTTPResponseError } from '../adapters/fetch'
import { WorldStatus } from '../types'

/**
 * Iteration 2: Pulse becomes the source of online-player information. This module holds the
 * configuration switch and the two Pulse reads the service needs, so the comms adapter and the
 * `connected-world` handler agree on both.
 *
 * Only the *counters* move. Capacity checks (`MAX_USERS_PER_WORLD`) and participant kicks keep
 * reading LiveKit, which is the authority on who is actually attached to a room.
 */

/** Realms whose name ends with this suffix are worlds; everything else is Genesis City or a local scene. */
export const WORLD_NAME_SUFFIX = '.dcl.eth'

/** `livekit` is today's behaviour, and stays the default so a deploy with no config change is a no-op. */
export type PresenceSource = 'livekit' | 'pulse' | 'both'

export const DEFAULT_PRESENCE_SOURCE: PresenceSource = 'livekit'

/**
 * Reads `PRESENCE_SOURCE`. Anything other than `pulse` or `both` — including an absent or
 * misspelled value — resolves to `livekit`, so a bad configuration degrades to today's behaviour
 * instead of taking the service down.
 */
export async function getPresenceSource(config: Pick<IConfigComponent, 'getString'>): Promise<PresenceSource> {
  const configured = (await config.getString('PRESENCE_SOURCE'))?.trim().toLowerCase()
  return configured === 'pulse' || configured === 'both' ? configured : DEFAULT_PRESENCE_SOURCE
}

export type PulseRealm = {
  name: string
  peers: number
  clusters: number
}

/** `GET ${PULSE_URL}/realms` (C2): every realm with at least one peer, names canonical lowercase. */
export type PulseRealms = {
  realms: PulseRealm[]
  lastUpdated: string
}

/** `GET ${PULSE_URL}/peers/:id` (C2): `404 {"ok":false,"peer":null}` when the peer is not online. */
export type PulsePeerResponse = {
  ok: boolean
  peer: { address: string; realm: string } | null
}

export function isWorldRealm(realmName: string): boolean {
  return realmName.toLowerCase().endsWith(WORLD_NAME_SUFFIX)
}

/** Maps the Pulse realm list onto the `WorldStatus` entries `/live-data` and `/status` publish. */
export function worldStatusesFromRealms(realms: PulseRealm[]): WorldStatus[] {
  return realms
    .filter((realm) => isWorldRealm(realm.name))
    .map((realm) => ({ worldName: realm.name, users: realm.peers }))
}

function pulseEndpoint(pulseUrl: string, path: string): string {
  return `${pulseUrl.replace(/\/+$/, '')}${path}`
}

const JSON_REQUEST = {
  method: 'GET',
  headers: { 'Content-Type': 'application/json' }
} as const

export async function fetchPulseRealms(
  fetch: IFetchComponent,
  pulseUrl: string
): Promise<{ worlds: WorldStatus[]; lastUpdated: number }> {
  const response = await fetch.fetch(pulseEndpoint(pulseUrl, '/realms'), JSON_REQUEST)
  const body = (await response.json()) as PulseRealms

  const lastUpdated = body?.lastUpdated ? Date.parse(body.lastUpdated) : Number.NaN

  return {
    worlds: worldStatusesFromRealms(body?.realms ?? []),
    lastUpdated: Number.isNaN(lastUpdated) ? Date.now() : lastUpdated
  }
}

function isPeerNotFound(error: unknown): boolean {
  return error instanceof HTTPResponseError && error.response.status === 404
}

/**
 * Resolves the realm a peer is in, or `undefined` when Pulse does not know the peer. The service's
 * fetch component rejects non-2xx responses, so the contract's `404 {"ok":false,"peer":null}`
 * arrives either as a rejection or — with a plain fetch — as a 404 response; both mean "offline".
 */
export async function fetchPulsePeerRealm(
  fetch: IFetchComponent,
  pulseUrl: string,
  peerId: string
): Promise<string | undefined> {
  let response: Response
  try {
    response = await fetch.fetch(pulseEndpoint(pulseUrl, `/peers/${encodeURIComponent(peerId)}`), JSON_REQUEST)
  } catch (error) {
    if (isPeerNotFound(error)) {
      return undefined
    }
    throw error
  }

  if (response.status === 404) {
    return undefined
  }

  const body = (await response.json()) as PulsePeerResponse

  return body?.ok && body.peer?.realm ? body.peer.realm : undefined
}
