import { createFetchComponent as createBaseFetchComponent } from '@dcl/fetch-component'
import { IFetchComponent } from '@dcl/core-commons'

/**
 * Error thrown when a fetch resolves with a non-2xx status. This mirrors the
 * behaviour previously provided by `@dcl/platform-server-commons`'
 * `createFetchComponent`, which the rest of the service relies on: callers do
 * not inspect `response.ok` themselves, they expect a rejected promise on
 * non-successful responses.
 */
export class HTTPResponseError extends Error {
  constructor(public readonly response: Response) {
    super(`HTTP Error Response: ${response.status} ${response.statusText} for URL ${response.url}`)
  }
}

/**
 * Builds the fetch component used across the service.
 *
 * It wraps `@dcl/fetch-component` (backed by the native Node `fetch`, so no
 * `node-fetch` dependency) and re-applies the throw-on-non-2xx semantics that
 * the previous implementation guaranteed.
 */
export async function createFetchComponent(): Promise<IFetchComponent> {
  const fetch = createBaseFetchComponent()

  return {
    async fetch(url, init) {
      const response = await fetch.fetch(url, init)
      if (response.ok) {
        // response.status >= 200 && response.status < 300
        return response
      }

      // Drain the unread body before throwing so undici can release the
      // connection back to its pool. Callers only read `error.message`
      // (status/statusText/url), never the body, so cancelling here is safe.
      await response.body?.cancel().catch(() => undefined)
      throw new HTTPResponseError(response)
    }
  }
}
