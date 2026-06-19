import { IHttpServerComponent } from '@dcl/core-commons'

export function extractCommsRateLimitSubject(request: IHttpServerComponent.IRequest, identity: string): string {
  return request.headers.get('cf-connecting-ip') || identity
}
