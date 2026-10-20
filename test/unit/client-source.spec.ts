import { IHttpServerComponent } from '@dcl/core-commons'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createClientSourceComponent, IClientSourceComponent } from '../../src/logic/client-source'

describe('when resolving the client source of a request', () => {
  let env: Record<string, string>
  let headers: Record<string, string>
  let clientSource: IClientSourceComponent
  let source: string | undefined

  function request(): IHttpServerComponent.IRequest {
    return { headers: new Headers(headers) } as unknown as IHttpServerComponent.IRequest
  }

  beforeEach(() => {
    env = {}
    headers = { 'cf-connecting-ip': '203.0.113.1', 'x-real-ip': '198.51.100.7' }
  })

  describe('and no trusted header is configured', () => {
    beforeEach(async () => {
      clientSource = await createClientSourceComponent({ config: createConfigComponent(env) })
      source = clientSource.getClientSource(request())
    })

    it('should use the address Cloudflare reports in cf-connecting-ip', () => {
      expect(source).toBe('203.0.113.1')
    })
  })

  describe('and another trusted header is configured', () => {
    beforeEach(async () => {
      env.TRUSTED_CLIENT_IP_HEADER = '  X-Real-IP  '
      clientSource = await createClientSourceComponent({ config: createConfigComponent(env) })
      source = clientSource.getClientSource(request())
    })

    it('should use that header, trimmed and case-insensitively', () => {
      expect({ header: clientSource.header, source }).toEqual({ header: 'x-real-ip', source: '198.51.100.7' })
    })
  })

  describe('and the configured header is blank', () => {
    beforeEach(async () => {
      env.TRUSTED_CLIENT_IP_HEADER = '   '
      clientSource = await createClientSourceComponent({ config: createConfigComponent(env) })
    })

    it('should fall back to cf-connecting-ip', () => {
      expect(clientSource.header).toBe('cf-connecting-ip')
    })
  })

  describe('and the configured header is not a valid header name', () => {
    let creation: Promise<IClientSourceComponent>

    beforeEach(() => {
      env.TRUSTED_CLIENT_IP_HEADER = 'x real ip'
      creation = createClientSourceComponent({ config: createConfigComponent(env) })
    })

    it('should refuse to start', async () => {
      await expect(creation).rejects.toThrow('Invalid TRUSTED_CLIENT_IP_HEADER')
    })
  })

  describe('and the request lacks the trusted header', () => {
    beforeEach(async () => {
      delete headers['cf-connecting-ip']
      clientSource = await createClientSourceComponent({ config: createConfigComponent(env) })
      source = clientSource.getClientSource(request())
    })

    it('should report no client source', () => {
      expect(source).toBeUndefined()
    })
  })

  describe('and the trusted header is empty', () => {
    beforeEach(async () => {
      headers['cf-connecting-ip'] = ''
      clientSource = await createClientSourceComponent({ config: createConfigComponent(env) })
      source = clientSource.getClientSource(request())
    })

    it('should report no client source', () => {
      expect(source).toBeUndefined()
    })
  })
})
