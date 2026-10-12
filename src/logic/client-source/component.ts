import { AppComponents } from '../../types'
import { IClientSourceComponent } from './types'

// Worlds is always behind Cloudflare, which sends the connecting client's address in CF-Connecting-IP.
export const DEFAULT_TRUSTED_CLIENT_IP_HEADER = 'cf-connecting-ip'

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Creates the client-source resolver used by per-source upload limits and comms rate limiting.
 * TRUSTED_CLIENT_IP_HEADER names the header the edge proxy overwrites with the client's address;
 * requests without it reached the service without the proxy (internal callers).
 * @param components Configuration.
 * @returns The client-source resolver.
 * @throws Error when TRUSTED_CLIENT_IP_HEADER is not a valid HTTP header name.
 */
export async function createClientSourceComponent(
  components: Pick<AppComponents, 'config'>
): Promise<IClientSourceComponent> {
  const { config } = components
  const configured = (await config.getString('TRUSTED_CLIENT_IP_HEADER'))?.trim()
  const header = (configured || DEFAULT_TRUSTED_CLIENT_IP_HEADER).toLowerCase()
  if (!HEADER_NAME.test(header)) {
    throw new Error(`Invalid TRUSTED_CLIENT_IP_HEADER: expected an HTTP header name but got "${configured}"`)
  }

  return {
    header,
    getClientSource(request) {
      return request.headers.get(header) || undefined
    }
  }
}
