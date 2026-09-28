import { IHttpServerComponent } from '@dcl/core-commons'
import { getClientSource } from '../client-source'

export function extractCommsRateLimitSubject(request: IHttpServerComponent.IRequest, identity: string): string {
  return getClientSource(request) || identity
}
