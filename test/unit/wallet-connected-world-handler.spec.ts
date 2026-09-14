import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { IHttpServerComponent } from '@dcl/core-commons'
import {
  clearConnectedWorldCache,
  walletConnectedWorldHandler
} from '../../src/controllers/handlers/wallet-connected-world-handler'
import { HTTPResponseError } from '../../src/adapters/fetch'
import { HandlerContextWithPath } from '../../src/types'
import { createMockedConfig } from '../mocks/config-mock'
import { loadHttpGolden, PulsePeerBody, PulsePeersBody } from '../fixtures/iteration-2/http-goldens'

type HandlerContext = HandlerContextWithPath<'config' | 'fetch', '/wallet/:wallet/connected-world'> &
  DecentralandSignatureContext<any>

const PULSE_URL = 'https://pulse.example.com'

const peerGolden = loadHttpGolden<PulsePeerBody>('peers-single')
const peerNotFoundGolden = loadHttpGolden<PulsePeerBody>('peers-single-404')
const peersAllGolden = loadHttpGolden<PulsePeersBody>('peers-all')

// The pack pins the single-peer envelope for a world peer (`peers-single.json`) and for an unknown
// one (`peers-single-404.json`). The Genesis City case reuses the `main` peer of `peers-all.json`
// wrapped in that same envelope, so every byte still comes from the pack.
const genesisPeer = peersAllGolden.body.peers.find((peer) => peer.realm === 'main')!
const genesisPeerBody: PulsePeerBody = { ok: true, peer: genesisPeer }

describe('walletConnectedWorldHandler', () => {
  let config: ReturnType<typeof createMockedConfig>
  let fetchMock: jest.Mock

  function buildContext(wallet: string): HandlerContext {
    return {
      components: { config, fetch: { fetch: fetchMock } },
      params: { wallet }
    } as unknown as HandlerContext
  }

  function pulseResponse(body: PulsePeerBody, status = 200): Response {
    return new Response(JSON.stringify(body), { status })
  }

  beforeEach(() => {
    // The Pulse lookup is cached in module state, so every case has to start from an empty cache.
    clearConnectedWorldCache()
    fetchMock = jest.fn()
    config = createMockedConfig()
    config.requireString.mockImplementation(async (name: string) => {
      if (name === 'PULSE_URL') return PULSE_URL
      throw new Error(`Configuration: string ${name} is required`)
    })
  })

  describe('and the peer is in a world realm', () => {
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      fetchMock.mockResolvedValue(pulseResponse(peerGolden.body))
      response = await walletConnectedWorldHandler(buildContext(peerGolden.body.peer!.address))
    })

    it('should ask Pulse for that single peer', () => {
      expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/peers/${peerGolden.body.peer!.address}`, expect.anything())
    })

    it('should answer with the realm as the connected world', () => {
      expect(response).toEqual({
        status: 200,
        body: { wallet: peerGolden.body.peer!.address, world: 'cozyfarm.dcl.eth' }
      })
    })
  })

  describe('and the peer is in Genesis City', () => {
    it('should answer 404', async () => {
      fetchMock.mockResolvedValue(pulseResponse(genesisPeerBody))

      await expect(walletConnectedWorldHandler(buildContext(genesisPeer.address))).rejects.toThrow(
        `Wallet ${genesisPeer.address} is not connected to any world`
      )
      expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/peers/${genesisPeer.address}`, expect.anything())
    })
  })

  describe('and the peer is unknown to Pulse', () => {
    it('should answer 404 when Pulse answers 404', async () => {
      fetchMock.mockResolvedValue(pulseResponse(peerNotFoundGolden.body, 404))

      await expect(walletConnectedWorldHandler(buildContext('0xunknown'))).rejects.toThrow(
        'Wallet 0xunknown is not connected to any world'
      )
      expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/peers/0xunknown`, expect.anything())
    })

    it('should answer 404 when the fetch component rejects the 404', async () => {
      fetchMock.mockRejectedValue(new HTTPResponseError(pulseResponse(peerNotFoundGolden.body, 404)))

      await expect(walletConnectedWorldHandler(buildContext('0xunknown'))).rejects.toThrow(
        'Wallet 0xunknown is not connected to any world'
      )
      expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/peers/0xunknown`, expect.anything())
    })
  })

  // C4-connected-world: `world` stays lowercase, matching the canonical spelling Pulse and
  // `/live-data` both key on.
  describe('and Pulse answers with a mixed-case realm', () => {
    it('should answer with the world lowercased', async () => {
      const address = peerGolden.body.peer!.address
      fetchMock.mockResolvedValue(
        pulseResponse({ ok: true, peer: { ...peerGolden.body.peer!, realm: 'CozyFarm.DCL.eth' } })
      )

      const response = await walletConnectedWorldHandler(buildContext(address))

      expect(response).toEqual({ status: 200, body: { wallet: address, world: 'cozyfarm.dcl.eth' } })
    })
  })

  // Pulse ids are lowercase (the pack pins `0x…00AB` ingesting as `0x…00ab`), so the route is
  // case-insensitive on the wallet. Forwarding an EIP-55 checksummed address verbatim would have
  // 404'd a wallet that answers 200 now, on a frozen route.
  describe('and the wallet is checksummed', () => {
    const checksummed = '0x00000000000000000000000000000000000000AB'
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      fetchMock.mockResolvedValue(pulseResponse(peerGolden.body))
      response = await walletConnectedWorldHandler(buildContext(checksummed))
    })

    it('should ask Pulse for the lowercased wallet', () => {
      expect(fetchMock).toHaveBeenCalledWith(
        `${PULSE_URL}/peers/0x00000000000000000000000000000000000000ab`,
        expect.anything()
      )
    })

    it('should echo the wallet back exactly as it was requested', () => {
      expect(response).toEqual({ status: 200, body: { wallet: checksummed, world: 'cozyfarm.dcl.eth' } })
    })
  })

  // The route is public, unauthenticated and unthrottled, so without this every request would be
  // one more Pulse call.
  describe('and the same wallet is requested twice inside the cache window', () => {
    beforeEach(() => {
      // A fresh Response per call: a body can only be read once.
      fetchMock.mockImplementation(async () => pulseResponse(peerGolden.body))
    })

    it('should ask Pulse only once', async () => {
      const wallet = peerGolden.body.peer!.address

      await walletConnectedWorldHandler(buildContext(wallet))
      await walletConnectedWorldHandler(buildContext(wallet))

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('should cache per wallet, not globally', async () => {
      await walletConnectedWorldHandler(buildContext(peerGolden.body.peer!.address))
      await walletConnectedWorldHandler(buildContext('0x0000000000000000000000000000000000000004'))

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('should serve a checksummed and a lowercase spelling of one wallet from the same entry', async () => {
      await walletConnectedWorldHandler(buildContext('0x00000000000000000000000000000000000000AB'))
      await walletConnectedWorldHandler(buildContext('0x00000000000000000000000000000000000000ab'))

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  // C4-no-fallback: a Pulse failure that is not a "peer not found" 404 answers 503, never a
  // LiveKit-derived guess (there is no LiveKit-fed answer left to fall back to).
  //
  // The 503 body must never echo the raw upstream error text: this route is public, unauthenticated
  // and unthrottled, and the raw message (`src/adapters/fetch.ts`'s `HTTPResponseError`) names the
  // internal PULSE_URL host/port/path. The fixed message matches the one `comms-adapter.ts` throws.
  describe('and Pulse fails', () => {
    it('should answer 503 with a fixed message, never the raw upstream error text', async () => {
      fetchMock.mockRejectedValue(
        new Error(
          'HTTP Error Response: 500 Internal Server Error for URL https://pulse.internal.example.com/peers/0xtest'
        )
      )

      const response = await walletConnectedWorldHandler(buildContext('0xtest'))

      expect(response).toEqual({
        status: 503,
        body: { error: 'Service Unavailable', message: 'Pulse presence is unavailable' }
      })
    })
  })

  // Secondary defect this guards against: a blanket `catch (error: any)` would also convert a
  // genuine programming error (a bug in `getConnectedWorldFromPulse`, not a Pulse failure) into
  // "503 Service Unavailable", sending an on-call engineer to the wrong service. Only
  // `PulseUnavailableError` may become a 503; anything else must propagate to the framework's
  // generic error handler (a 500 with no message), exactly as it did before this branch existed.
  describe('and a bug throws inside the handler, unrelated to Pulse', () => {
    it('should not convert a TypeError into a 503', async () => {
      // No `wallet` param at all: `getConnectedWorldFromPulse` calls `wallet.toLowerCase()` before
      // ever touching Pulse, so this TypeError is not a Pulse failure of any kind.
      const context = {
        components: { config, fetch: { fetch: fetchMock } },
        params: {}
      } as unknown as HandlerContext

      await expect(walletConnectedWorldHandler(context)).rejects.toThrow(TypeError)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
