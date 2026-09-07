import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IFetchComponent, RequestOptions } from '@dcl/core-commons'
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
export function worldStatusesFromRealms(
  realms: PulseRealm[],
  logger?: Pick<ILoggerComponent.ILogger, 'warn'>
): WorldStatus[] {
  const worldRealms = realms.filter((realm) => isWorldRealm(realm.name))

  // C4 guarantees `worldName` stays lowercase. Pulse canonicalizes realm names at ingest, and the
  // contract pack asks consumers to treat a non-lowercase value on the wire as a violation to log
  // rather than a reason to drop the realm (`parcel_changes/07-invalid-mixed-case-realm`). So:
  // normalize, and say so — `/live-data` consumers (places, the explorer world list) key on the
  // lowercase name, and the LiveKit path can never emit anything else.
  const nonCanonical = worldRealms.filter((realm) => realm.name !== realm.name.toLowerCase())
  if (nonCanonical.length > 0 && logger) {
    logger.warn('Pulse answered /realms with non-lowercase realm names; normalizing them', {
      realms: nonCanonical.map((realm) => realm.name).join(',')
    })
  }

  return (
    worldRealms
      .map((realm) => ({ worldName: realm.name.toLowerCase(), users: realm.peers }))
      // Both transports drop empty rooms before building `details` (`comms-adapter.ts`), so the
      // Pulse mapper has to as well: otherwise `/live-data` lists a draining world that the LiveKit
      // answer for the same world set omits, breaking the parity WP5 accepts on.
      .filter((world) => world.users > 0)
  )
}

function pulseEndpoint(pulseUrl: string, path: string): string {
  return `${pulseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * Deadline for every Pulse read. `createFetchComponent()` (`src/adapters/fetch.ts`) is built with
 * no default options and `@dcl/fetch-component` only arms its abort timer when a timeout is passed,
 * so without this a Pulse that accepts the connection and then stalls (a wedged pod, a hung DB
 * read) would hang the caller for as long as the socket stays open: under `PRESENCE_SOURCE=pulse`
 * that is every cache-miss request to `/live-data`, `/status` and `/wallet/:wallet/connected-world`.
 * 5 s sits well above Pulse's expected latency and well below the gateway timeouts in front of
 * those public routes, so a Pulse incident degrades the answer instead of the request.
 */
export const PULSE_REQUEST_TIMEOUT_MS = 5_000

const JSON_REQUEST = {
  method: 'GET',
  headers: { 'Content-Type': 'application/json' }
} as const

/**
 * Runs one Pulse read under `PULSE_REQUEST_TIMEOUT_MS`.
 *
 * The `AbortController` is what actually cancels the exchange — it is handed to the fetch component
 * as `abortController` (the knob `@dcl/fetch-component` puts on the request `signal`), so aborting
 * it tears down the connection instead of leaking a socket, and it also errors the body stream, not
 * just the headers. The race is what makes the *caller* give up on time: the deadline has to cover
 * `response.json()` too, and a transport that ignores the signal must not be able to hang us.
 */
async function withPulseDeadline<T>(read: (init: RequestOptions) => Promise<T>): Promise<T> {
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), PULSE_REQUEST_TIMEOUT_MS)
  const deadline = new Promise<never>((_, reject) => {
    abortController.signal.addEventListener('abort', () =>
      reject(new Error(`Pulse request timed out after ${PULSE_REQUEST_TIMEOUT_MS} ms`))
    )
  })

  try {
    return await Promise.race([read({ ...JSON_REQUEST, abortController, signal: abortController.signal }), deadline])
  } finally {
    // Cleared on every exit, so a read that answered in time cannot be aborted afterwards and the
    // `deadline` promise stays pending-and-unrejected rather than becoming an unhandled rejection.
    clearTimeout(timer)
  }
}

export async function fetchPulseRealms(
  fetch: IFetchComponent,
  pulseUrl: string,
  logger?: Pick<ILoggerComponent.ILogger, 'warn'>
): Promise<{ worlds: WorldStatus[]; lastUpdated: number }> {
  const body = await withPulseDeadline(async (init) => {
    const response = await fetch.fetch(pulseEndpoint(pulseUrl, '/realms'), init)
    return (await response.json()) as PulseRealms
  })

  const lastUpdated = body?.lastUpdated ? Date.parse(body.lastUpdated) : Number.NaN

  return {
    worlds: worldStatusesFromRealms(body?.realms ?? [], logger),
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
  let body: PulsePeerResponse | undefined
  try {
    body = await withPulseDeadline(async (init) => {
      const response = await fetch.fetch(pulseEndpoint(pulseUrl, `/peers/${encodeURIComponent(peerId)}`), init)
      return response.status === 404 ? undefined : ((await response.json()) as PulsePeerResponse)
    })
  } catch (error) {
    if (isPeerNotFound(error)) {
      return undefined
    }
    throw error
  }

  const realm = body?.ok && body.peer?.realm ? body.peer.realm : undefined

  // Defensive normalization, symmetrical with `worldStatusesFromRealms`: Pulse realm names are
  // canonical lowercase by contract, and the LiveKit-fed path can only ever emit lowercase
  // (`peers-registry.ts` lowercases every name it stores). Serving Pulse's spelling verbatim would
  // let `/wallet/:wallet/connected-world` answer `CozyFarm.dcl.eth` where the sibling `/live-data`
  // world list — and today's registry answer — say `cozyfarm.dcl.eth`, which is a miss for any
  // consumer comparing the two or interpolating the value into a world URL.
  return realm?.toLowerCase()
}
