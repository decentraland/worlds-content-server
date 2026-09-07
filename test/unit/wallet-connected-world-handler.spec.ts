import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { IHttpServerComponent } from '@dcl/core-commons'
import {
  clearConnectedWorldCache,
  walletConnectedWorldHandler
} from '../../src/controllers/handlers/wallet-connected-world-handler'
import { HTTPResponseError } from '../../src/adapters/fetch'
import { HandlerContextWithPath, IPeersRegistry } from '../../src/types'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockPeersRegistry } from '../mocks/peers-registry-mock'
import { loadHttpGolden, PulsePeerBody, PulsePeersBody } from '../fixtures/iteration-2/http-goldens'

type HandlerContext = HandlerContextWithPath<'config' | 'fetch' | 'peersRegistry', '/wallet/:wallet/connected-world'> &
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
  let peersRegistry: jest.Mocked<IPeersRegistry>
  let fetchMock: jest.Mock

  function buildContext(wallet: string): HandlerContext {
    return {
      components: { config, fetch: { fetch: fetchMock }, peersRegistry },
      params: { wallet }
    } as unknown as HandlerContext
  }

  function pulseResponse(body: PulsePeerBody, status = 200): Response {
    return new Response(JSON.stringify(body), { status })
  }

  beforeEach(() => {
    // The Pulse lookup is cached in module state, so every case has to start from an empty cache.
    clearConnectedWorldCache()
    peersRegistry = createMockPeersRegistry()
    fetchMock = jest.fn()
    config = createMockedConfig()
    config.getString.mockResolvedValue(undefined)
    config.requireString.mockImplementation(async (name: string) => {
      if (name === 'PULSE_URL') return PULSE_URL
      throw new Error(`Configuration: string ${name} is required`)
    })
  })

  describe('when PRESENCE_SOURCE is not configured', () => {
    it('should answer from the LiveKit-fed peers registry', async () => {
      peersRegistry.getPeerWorld.mockReturnValue('cozyfarm.dcl.eth')

      const response = await walletConnectedWorldHandler(buildContext('0xtest'))

      expect(response).toEqual({ status: 200, body: { wallet: '0xtest', world: 'cozyfarm.dcl.eth' } })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('should answer 404 when the registry has no world for the wallet', async () => {
      peersRegistry.getPeerWorld.mockReturnValue(undefined)

      await expect(walletConnectedWorldHandler(buildContext('0xtest'))).rejects.toThrow(
        'Wallet 0xtest is not connected to any world'
      )
    })
  })

  describe('when PRESENCE_SOURCE is pulse', () => {
    beforeEach(() => {
      config.getString.mockImplementation(async (name: string) => (name === 'PRESENCE_SOURCE' ? 'pulse' : undefined))
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

      it('should not read the peers registry', () => {
        expect(peersRegistry.getPeerWorld).not.toHaveBeenCalled()
      })
    })

    // Every 404 below also asserts *where the answer came from*: an empty peers registry answers
    // 404 too, so without these the cases would pass against the pre-Pulse handler.
    describe('and the peer is in Genesis City', () => {
      it('should answer 404', async () => {
        fetchMock.mockResolvedValue(pulseResponse(genesisPeerBody))

        await expect(walletConnectedWorldHandler(buildContext(genesisPeer.address))).rejects.toThrow(
          `Wallet ${genesisPeer.address} is not connected to any world`
        )
        expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/peers/${genesisPeer.address}`, expect.anything())
        expect(peersRegistry.getPeerWorld).not.toHaveBeenCalled()
      })
    })

    describe('and the peer is unknown to Pulse', () => {
      it('should answer 404 when Pulse answers 404', async () => {
        fetchMock.mockResolvedValue(pulseResponse(peerNotFoundGolden.body, 404))

        await expect(walletConnectedWorldHandler(buildContext('0xunknown'))).rejects.toThrow(
          'Wallet 0xunknown is not connected to any world'
        )
        expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/peers/0xunknown`, expect.anything())
        expect(peersRegistry.getPeerWorld).not.toHaveBeenCalled()
      })

      it('should answer 404 when the fetch component rejects the 404', async () => {
        fetchMock.mockRejectedValue(new HTTPResponseError(pulseResponse(peerNotFoundGolden.body, 404)))

        await expect(walletConnectedWorldHandler(buildContext('0xunknown'))).rejects.toThrow(
          'Wallet 0xunknown is not connected to any world'
        )
        expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/peers/0xunknown`, expect.anything())
        expect(peersRegistry.getPeerWorld).not.toHaveBeenCalled()
      })
    })

    // C4-connected-world: `world` stays lowercase. The registry-fed path can only ever answer
    // lowercase (`peers-registry.ts` lowercases every name it stores), so a mixed-case realm on the
    // wire must not make this route answer something `/live-data` — and today's registry answer —
    // never could.
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

    // Pulse ids are lowercase (the pack pins `0x…00AB` ingesting as `0x…00ab`) and the LiveKit-fed
    // registry path lowercases the id too, so the route is case-insensitive on the wallet today.
    // Forwarding an EIP-55 checksummed address verbatim would have 404'd a wallet that answers 200
    // now, on a frozen route.
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

    describe('and Pulse fails', () => {
      it('should surface the failure instead of pretending the wallet is offline', async () => {
        fetchMock.mockRejectedValue(new Error('pulse is down'))

        await expect(walletConnectedWorldHandler(buildContext('0xtest'))).rejects.toThrow('pulse is down')
      })
    })
  })

  describe('when PRESENCE_SOURCE is both', () => {
    it('should not cache the registry answer', async () => {
      config.getString.mockImplementation(async (name: string) => (name === 'PRESENCE_SOURCE' ? 'both' : undefined))
      peersRegistry.getPeerWorld.mockReturnValue('cozyfarm.dcl.eth')

      await walletConnectedWorldHandler(buildContext('0xtest'))
      await walletConnectedWorldHandler(buildContext('0xtest'))

      // The registry is an in-memory Map fed by the webhook: caching it would only add staleness.
      expect(peersRegistry.getPeerWorld).toHaveBeenCalledTimes(2)
    })

    it('should keep answering from the peers registry', async () => {
      config.getString.mockImplementation(async (name: string) => (name === 'PRESENCE_SOURCE' ? 'both' : undefined))
      peersRegistry.getPeerWorld.mockReturnValue('cozyfarm.dcl.eth')

      const response = await walletConnectedWorldHandler(buildContext('0xtest'))

      expect(response).toEqual({ status: 200, body: { wallet: '0xtest', world: 'cozyfarm.dcl.eth' } })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
