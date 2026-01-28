import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import { Authenticator } from '@dcl/crypto'
import { Readable } from 'stream'
import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { stringToUtf8Bytes } from 'eth-connect'
import { AuthChain } from '@dcl/schemas'
import { AUTH_CHAIN_HEADER_PREFIX, AUTH_METADATA_HEADER, AUTH_TIMESTAMP_HEADER } from '@dcl/platform-crypto-middleware'
import { IPgComponent } from '@well-known-components/pg-component'
import { IFetchComponent, IConfigComponent } from '@well-known-components/interfaces'
import { createLocalFetchCompoment } from '@well-known-components/test-helpers'
import { TestIdentity, IAuthenticatedFetchComponent, AuthenticatedRequestInit } from '../src/types'

// Re-export for convenience - tests use "Identity" name
export type Identity = TestIdentity

/**
 * Creates a fetch component that wraps the local fetch component and adds support
 * for authenticated requests. When an identity is provided, it automatically adds
 * the auth headers using the signed fetch pattern (ADR-44).
 */
export async function createAuthenticatedLocalFetchComponent(
  config: IConfigComponent
): Promise<IAuthenticatedFetchComponent> {
  const localFetch: IFetchComponent = await createLocalFetchCompoment(config)

  return {
    async fetch(path: string, init?: AuthenticatedRequestInit): Promise<Response> {
      const { identity, metadata, ...restInit } = init || {}
      const method = (restInit.method || 'GET').toUpperCase()

      const headers: Record<string, string> = {}

      // Copy existing headers
      if (restInit.headers) {
        if (restInit.headers instanceof Headers) {
          restInit.headers.forEach((value, key) => {
            headers[key] = value
          })
        } else if (Array.isArray(restInit.headers)) {
          restInit.headers.forEach(([key, value]) => {
            headers[key] = value
          })
        } else {
          Object.assign(headers, restInit.headers)
        }
      }

      // If identity is provided, add auth headers
      if (identity) {
        const authMetadata = metadata || {}
        const authHeaders = getAuthHeaders(method, path, authMetadata, (payload) =>
          Authenticator.signPayload(
            {
              ephemeralIdentity: identity.ephemeralIdentity,
              expiration: new Date(),
              authChain: identity.authChain.authChain
            },
            payload
          )
        )
        Object.assign(headers, authHeaders)
      }

      return localFetch.fetch(path, { ...restInit, headers }) as unknown as Promise<Response>
    }
  }
}

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

export async function getIdentity(): Promise<Identity> {
  const ephemeralIdentity = createUnsafeIdentity()
  const realAccount = createUnsafeIdentity()

  const authChain = await Authenticator.initializeAuthChain(
    realAccount.address,
    ephemeralIdentity,
    10,
    async (message) => {
      return Authenticator.createSignature(realAccount, message)
    }
  )

  return { authChain, realAccount, ephemeralIdentity }
}

export function getAuthHeaders(
  method: string,
  path: string,
  metadata: Record<string, any>,
  chainProvider: (payload: string) => AuthChain
) {
  const headers: Record<string, string> = {}
  const timestamp = Date.now()
  const metadataJSON = JSON.stringify(metadata)
  const payloadParts = [method.toLowerCase(), path.toLowerCase(), timestamp.toString(), metadataJSON]
  const payloadToSign = payloadParts.join(':').toLowerCase()

  const chain = chainProvider(payloadToSign)

  chain.forEach((link, index) => {
    headers[`${AUTH_CHAIN_HEADER_PREFIX}${index}`] = JSON.stringify(link)
  })

  headers[AUTH_TIMESTAMP_HEADER] = timestamp.toString()
  headers[AUTH_METADATA_HEADER] = metadataJSON

  return headers
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
