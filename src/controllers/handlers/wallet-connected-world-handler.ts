import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { IFetchComponent, IHttpServerComponent } from '@dcl/core-commons'
import { NotFoundError } from '@dcl/http-commons'
import { fetchPulsePeerRealm, getPresenceSource, isWorldRealm } from '../../logic/presence-source'

/**
 * @deprecated Iteration 2 replaces this route with Pulse's `GET /peers/:id`. It is kept for one
 * release while unity-explorer still calls it, and removed once the explorer reads Pulse directly.
 */
export async function walletConnectedWorldHandler(
  ctx: HandlerContextWithPath<'config' | 'fetch' | 'peersRegistry', '/wallet/:wallet/connected-world'> &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { config, fetch, peersRegistry },
    params
  } = ctx

  const { wallet } = params

  // `both` keeps serving the LiveKit-fed answer: the shadow comparison of the dual-source window is
  // scoped to the `/live-data` counters, this route is only read by the explorer.
  const world =
    (await getPresenceSource(config)) === 'pulse'
      ? await getConnectedWorldFromPulse(fetch, await config.requireString('PULSE_URL'), wallet)
      : peersRegistry.getPeerWorld(wallet)

  if (!world) {
    throw new NotFoundError(`Wallet ${wallet} is not connected to any world`)
  }

  return {
    status: 200,
    body: {
      wallet,
      world
    }
  }
}

/** A peer is "in a world" only when its Pulse realm is a world name; Genesis City is not a world. */
async function getConnectedWorldFromPulse(
  fetch: IFetchComponent,
  pulseUrl: string,
  wallet: string
): Promise<string | undefined> {
  const realm = await fetchPulsePeerRealm(fetch, pulseUrl, wallet)
  return realm && isWorldRealm(realm) ? realm : undefined
}
