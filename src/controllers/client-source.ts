import { IHttpServerComponent } from '@dcl/core-commons'

/**
 * Resolves the client a request is limited as: the address Cloudflare reports.
 * @param request Incoming request.
 * @returns The client source, or undefined when the request didn't come through Cloudflare.
 */
export function getClientSource(request: IHttpServerComponent.IRequest): string | undefined {
  return request.headers.get('cf-connecting-ip') || undefined
}
