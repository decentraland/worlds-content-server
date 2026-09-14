import { test } from '../components'
import { clearConnectedWorldCache } from '../../src/controllers/handlers/wallet-connected-world-handler'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'
import { loadHttpGolden, PulsePeerBody, PulsePeersBody } from '../fixtures/iteration-2/http-goldens'

// C4-connected-world / C2-peers-single-consume: Pulse is the only source, so every case here answers
// from Pulse's single-peer route (`GET ${PULSE_URL}/peers/:id`), never from the LiveKit-fed registry.
test('WalletConnectedWorldHandler', function ({ components, stubComponents }) {
  const PULSE_URL = 'https://pulse.example.com'
  const peerGolden = loadHttpGolden<PulsePeerBody>('peers-single')
  const peerNotFoundGolden = loadHttpGolden<PulsePeerBody>('peers-single-404')
  const peersAllGolden = loadHttpGolden<PulsePeersBody>('peers-all')
  const genesisPeer = peersAllGolden.body.peers.find((peer) => peer.realm === 'main')!

  let localFetch: IAuthenticatedFetchComponent

  function servePulse(body: PulsePeerBody, status = 200): void {
    stubComponents.fetch.fetch.mockResolvedValue(new Response(JSON.stringify(body), { status }))
  }

  beforeEach(() => {
    localFetch = components.localFetch

    // The Pulse lookup is cached for a few seconds in module state; each case starts from empty.
    clearConnectedWorldCache()
    const { config } = stubComponents
    config.requireString.mockImplementation(async (name: string) => (name === 'PULSE_URL' ? PULSE_URL : ''))
  })

  it('should ask Pulse once for two requests inside the cache window', async () => {
    const wallet = peerGolden.body.peer!.address
    stubComponents.fetch.fetch.mockImplementation(async () => new Response(JSON.stringify(peerGolden.body)))

    await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })
    const response = await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })

    expect(response.status).toBe(200)
    expect(stubComponents.fetch.fetch).toHaveBeenCalledTimes(1)
  })

  it('should answer 200 with the realm when the peer is in a world', async () => {
    const wallet = peerGolden.body.peer!.address
    servePulse(peerGolden.body)

    const response = await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ wallet, world: 'cozyfarm.dcl.eth' })
    expect(stubComponents.fetch.fetch).toHaveBeenCalledWith(`${PULSE_URL}/peers/${wallet}`, expect.anything())
  })

  it('should answer 404 when the peer is in Genesis City', async () => {
    servePulse({ ok: true, peer: genesisPeer })

    const response = await localFetch.fetch(`/wallet/${genesisPeer.address}/connected-world`, { method: 'GET' })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      message: `Wallet ${genesisPeer.address} is not connected to any world`
    })
    expect(stubComponents.fetch.fetch).toHaveBeenCalledWith(
      `${PULSE_URL}/peers/${genesisPeer.address}`,
      expect.anything()
    )
  })

  it('should answer 404 when Pulse does not know the peer', async () => {
    servePulse(peerNotFoundGolden.body, 404)

    const response = await localFetch.fetch('/wallet/0xunknown/connected-world', { method: 'GET' })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      message: 'Wallet 0xunknown is not connected to any world'
    })
    expect(stubComponents.fetch.fetch).toHaveBeenCalledWith(`${PULSE_URL}/peers/0xunknown`, expect.anything())
  })

  it('should return 404 for empty wallet address', async () => {
    const response = await localFetch.fetch('/wallet//connected-world', { method: 'GET' })
    expect(response.status).toBe(404)
  })

  // C4-no-fallback: a Pulse failure that is not "peer not found" answers 503, never a LiveKit-fed
  // guess — there is no registry fallback left.
  it('should answer 503 when Pulse fails', async () => {
    stubComponents.fetch.fetch.mockRejectedValue(new Error('pulse is down'))

    const response = await localFetch.fetch('/wallet/0xtest/connected-world', { method: 'GET' })

    expect(response.status).toBe(503)
  })
})
