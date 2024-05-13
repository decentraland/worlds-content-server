import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export async function getContributableDomainsHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/world/contribute'> & DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { worldsManager } = ctx.components
  const address = ctx.verification!.auth
  const body = await worldsManager.getContributableDomains(address)

  return {
    status: 200,
    body
  }
}
