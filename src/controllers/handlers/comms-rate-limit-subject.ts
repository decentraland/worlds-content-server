import { IHttpServerComponent } from '@dcl/core-commons'
import { IClientSourceComponent } from '../../logic/client-source'

export function extractCommsRateLimitSubject(
  clientSource: IClientSourceComponent,
  request: IHttpServerComponent.IRequest,
  identity: string
): string {
  return clientSource.getClientSource(request) || identity
}
