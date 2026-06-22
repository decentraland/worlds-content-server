import { Authenticator } from '@dcl/crypto'
import { IConfigComponent } from '@well-known-components/interfaces'
import { IFetchComponent } from '@dcl/core-commons'
import { createLocalFetchComponent } from '@dcl/test-helpers'
import { AuthenticatedRequestInit, IAuthenticatedFetchComponent } from './types'
import { getAuthHeaders } from '../../utils'

/**
 * The npm `form-data` package exposes its serialized bytes via `getBuffer()` and its multipart
 * `Content-Type` (including the boundary) via `getHeaders()`. It is not a native `BodyInit`, so the
 * native `fetch` backing `@dcl/test-helpers`' local fetch component serializes it to `text/plain` and
 * the server's multipart parser rejects it. It needs converting before being handed to `fetch`.
 */
type NodeFormDataBody = { getBuffer(): Buffer; getHeaders(): Record<string, string> }

function isNodeFormDataBody(body: unknown): body is NodeFormDataBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as NodeFormDataBody).getBuffer === 'function' &&
    typeof (body as NodeFormDataBody).getHeaders === 'function'
  )
}

/**
 * Creates a fetch component that wraps the local fetch component and adds support
 * for authenticated requests. When an identity is provided, it automatically adds
 * the auth headers using the signed fetch pattern (ADR-44).
 */
export async function createAuthenticatedLocalFetchComponent(
  config: IConfigComponent
): Promise<IAuthenticatedFetchComponent> {
  const localFetch: IFetchComponent = await createLocalFetchComponent(config)

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

      // Materialize npm `form-data` bodies into a native body (a `Uint8Array`) and set the multipart
      // `Content-Type` (with boundary), otherwise the native `fetch` mis-serializes them and the
      // server's multipart parser rejects the request.
      if (isNodeFormDataBody(restInit.body)) {
        const form = restInit.body
        // `Buffer` (ArrayBufferLike-backed) isn't a native `BodyInit`; copy into a plain
        // `Uint8Array<ArrayBuffer>`, which undici accepts.
        restInit.body = new Uint8Array(form.getBuffer())
        Object.assign(headers, form.getHeaders())
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
