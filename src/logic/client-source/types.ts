import { IHttpServerComponent } from '@dcl/core-commons'

/** Resolves which client a request is limited as, from the header the edge proxy sets. */
export type IClientSourceComponent = {
  /** Lower-cased name of the trusted header that carries the connecting client's address. */
  readonly header: string
  /**
   * Resolves the client source of a request.
   * @param request Incoming request.
   * @returns The trusted header's value, or undefined when the request didn't come through the proxy.
   */
  getClientSource(request: IHttpServerComponent.IRequest): string | undefined
}
