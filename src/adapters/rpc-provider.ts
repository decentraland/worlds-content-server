import { IFetchComponent } from '@dcl/core-commons'
import { HTTPProvider } from 'eth-connect'

/**
 * Builds the eth-connect HTTPProvider used to talk to the configured RPC node.
 *
 * eth-connect's HTTPProvider consumes the RPC response body with `await
 * res.json()` *inside* its `fetch(...).then(onFulfilled)` callback. The fetch
 * implementation rejects that body read when the upstream RPC closes the
 * connection mid-body (native `fetch`/undici surfaces this as `TypeError:
 * terminated` with a `Premature close` cause). Because that rejection happens
 * in the fulfillment handler — not the `.then(_, onRejected)` handler, and with
 * no trailing `.catch()` — it escapes as an unhandled promise rejection that
 * crashes the process under `--unhandled-rejections=strict`. It also bypasses
 * the retry logic in name-ownership, which only sees errors delivered to the
 * sendAsync callback.
 *
 * This wrapper reads (and parses) the body *here*, inside the awaited fetch
 * call, so a premature close / stream error rejects the fetch promise that
 * HTTPProvider *does* handle. The failure then reaches the sendAsync callback
 * as an ordinary, retryable error instead of taking down the server.
 */
export function createEthereumProvider({ fetch }: { fetch: IFetchComponent }, rpcUrl: string): HTTPProvider {
  return new HTTPProvider(rpcUrl, {
    fetch: async (url: string, init: any) => {
      const response = await fetch.fetch(url, init)

      // Drain the body inside this awaited call so stream errors (premature
      // close, connection reset) reject *this* promise rather than escaping
      // later from inside HTTPProvider's fulfillment handler. Parsing here too
      // means a malformed body surfaces as a handled rejection rather than a
      // second unhandled-rejection surface in HTTPProvider's `res.json()`.
      const body = await response.text()
      const parsed = body.length > 0 ? JSON.parse(body) : undefined

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        json: async () => parsed
      }
    }
  })
}
