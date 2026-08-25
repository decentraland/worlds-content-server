import { Authenticator } from '@dcl/crypto'
import { Readable } from 'stream'
import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { stringToUtf8Bytes } from 'eth-connect'
import { AuthChain } from '@dcl/schemas'
import { AUTH_CHAIN_HEADER_PREFIX, AUTH_METADATA_HEADER, AUTH_TIMESTAMP_HEADER } from '@dcl/crypto-middleware'
import { IPgComponent } from '@dcl/pg-component'
import { getAuthHeaders, getIdentity, type Identity } from '@dcl/test-helpers'
import { IWorldsManager } from '../src/types'

// The modern ADR-44 payload is deliberately not rebuilt here: `@dcl/test-helpers` owns it, so it
// stays in step with `@dcl/crypto-middleware` instead of drifting in a hand-rolled copy per repo.
export { getAuthHeaders, getIdentity }
export type { Identity }

export async function storeJson(storage: IContentStorageComponent, fileId: string, data: any) {
  const buffer = stringToUtf8Bytes(JSON.stringify(data))
  let index = 0

  return await storage.storeStream(
    fileId,
    new Readable({
      read(size) {
        const readSize = Math.min(index + size, buffer.length - index)
        if (readSize === 0) {
          this.push(null)
          return
        }
        this.push(buffer.subarray(index, readSize))
        index += readSize
      }
    })
  )
}

export async function cleanup(storage: IContentStorageComponent, db: IPgComponent): Promise<void> {
  const files = []
  for await (const key of storage.allFileIds()) {
    files.push(key)
  }
  await storage.delete(files)

  await db.query(`TRUNCATE worlds, world_scenes CASCADE`)
}

/**
 * Builds modern ADR-44 headers stamped with a caller-chosen `timestamp`, so rejection tests can sign
 * a genuinely expired payload instead of merely tampering with an otherwise valid request.
 *
 * The shared helper always stamps `Date.now()` and exposes no timestamp parameter, so the clock is
 * pinned around the call rather than the payload being rebuilt here — the format keeps living in
 * exactly one place. Both the helper and `chainProvider` are synchronous, so nothing else observes
 * the pinned clock, and `new Date()` (which the auth chain's expiration uses) is left alone.
 */
export function getAuthHeadersAt(
  timestamp: number,
  method: string,
  pathname: string,
  metadata: Record<string, any>,
  chainProvider: (payload: string) => AuthChain
) {
  const realNow = Date.now
  Date.now = () => timestamp
  try {
    return getAuthHeaders(method, pathname, metadata, chainProvider)
  } finally {
    Date.now = realNow
  }
}

/**
 * Builds ADR-44 headers signing the **pre-6.0.0** payload: method, path, timestamp and metadata are
 * joined and then folded as a whole. Folding the metadata bytes is what left their casing outside
 * the signature, and it is still the format every explorer client emits.
 *
 * Only the routes that opt in via `canonicalMetadataKeys` verify this; everywhere else it is a 401.
 *
 * `@dcl/test-helpers` has no equivalent by design — it only builds the current payload — so this one
 * stays local. Importing the shared helper here would delete the coverage of that fallback path.
 */
export function getLegacyAuthHeaders(
  method: string,
  pathname: string,
  metadata: Record<string, any>,
  chainProvider: (payload: string) => AuthChain,
  timestamp = Date.now()
) {
  const headers: Record<string, string> = {}
  const metadataJSON = JSON.stringify(metadata)
  const payloadToSign = [method, pathname, timestamp.toString(), metadataJSON].join(':').toLowerCase()

  const chain = chainProvider(payloadToSign)

  chain.forEach((link, index) => {
    headers[`${AUTH_CHAIN_HEADER_PREFIX}${index}`] = JSON.stringify(link)
  })

  headers[AUTH_TIMESTAMP_HEADER] = timestamp.toString()
  headers[AUTH_METADATA_HEADER] = metadataJSON

  return headers
}

/** Signs a payload with the ephemeral identity, as a `chainProvider` for the helpers above. */
export function signWith(identity: Identity): (payload: string) => AuthChain {
  return (payload: string) =>
    Authenticator.signPayload(
      {
        ephemeralIdentity: identity.ephemeralIdentity,
        expiration: new Date(),
        authChain: identity.authChain.authChain
      },
      payload
    )
}

export async function hasWorldSceneIncludingUndeployed(
  worldsManager: IWorldsManager,
  worldName: string,
  sceneId: string
): Promise<boolean> {
  const { scenes } = await worldsManager.getWorldScenes(
    { worldName, entityId: sceneId, includeUndeployed: true },
    { limit: 1 }
  )
  return scenes.length > 0
}

export function makeid(length: number) {
  let result = ''
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const charactersLength = characters.length
  let counter = 0
  while (counter < length) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength))
    counter += 1
  }
  return result
}

/**
 * Builds bytes that pass the world thumbnail image check: a PNG signature followed by filler, so
 * fixtures exercise the same validation a real thumbnail upload would.
 */
export function makePngBytes(length: number = 500): Uint8Array {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const filler = Buffer.from(makeid(Math.max(0, length - signature.length)), 'utf8')
  return new Uint8Array(Buffer.concat([signature, filler]))
}
