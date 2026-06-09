import { IHttpServerComponent } from '@well-known-components/interfaces'

export function extractCommsRateLimitSubject(request: IHttpServerComponent.IRequest, identity: string): string {
  return request.headers.get('cf-connecting-ip') || identity
}
