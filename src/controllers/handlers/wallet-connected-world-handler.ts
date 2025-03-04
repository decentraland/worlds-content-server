import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { NotFoundError } from '@dcl/platform-server-commons'

export async function walletConnectedWorldHandler(
  ctx: HandlerContextWithPath<'peersRegistry', '/wallet/:wallet/connected-world'> & DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { peersRegistry },
    params
  } = ctx

  const { wallet } = params

  const world = peersRegistry.getPeerWorld(wallet)

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
