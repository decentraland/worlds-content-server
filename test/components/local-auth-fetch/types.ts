import { Identity } from '../../utils'

export type AuthenticatedRequestInit = Omit<RequestInit, 'body'> & {
  identity?: Identity
  metadata?: Record<string, any>
  body?: any
}

export type IAuthenticatedFetchComponent = {
  fetch(path: string, init?: AuthenticatedRequestInit): Promise<Response>
}
