import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { IHttpServerComponent } from '@dcl/core-commons'
import { walletConnectedWorldHandler } from '../../src/controllers/handlers/wallet-connected-world-handler'
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

    describe('and Pulse fails', () => {
      it('should surface the failure instead of pretending the wallet is offline', async () => {
        fetchMock.mockRejectedValue(new Error('pulse is down'))

        await expect(walletConnectedWorldHandler(buildContext('0xtest'))).rejects.toThrow('pulse is down')
      })
    })
  })

  describe('when PRESENCE_SOURCE is both', () => {
    it('should keep answering from the peers registry', async () => {
      config.getString.mockImplementation(async (name: string) => (name === 'PRESENCE_SOURCE' ? 'both' : undefined))
      peersRegistry.getPeerWorld.mockReturnValue('cozyfarm.dcl.eth')

      const response = await walletConnectedWorldHandler(buildContext('0xtest'))

      expect(response).toEqual({ status: 200, body: { wallet: '0xtest', world: 'cozyfarm.dcl.eth' } })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
