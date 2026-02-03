import { Authenticator } from '@dcl/crypto'
import { IConfigComponent, IFetchComponent } from '@well-known-components/interfaces'
import { createLocalFetchCompoment } from '@well-known-components/test-helpers'
import { AuthenticatedRequestInit, IAuthenticatedFetchComponent } from './types'
import { getAuthHeaders } from '../../utils'

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
