import { test } from '../components'

test('WalletConnectedWorldHandler', function ({ components, stubComponents }) {
  async function makeRequest(wallet: string) {
    const { localFetch } = components

    return localFetch.fetch(`/wallet/${wallet}/connected-world`, {
      method: 'GET'
    })
  }

  it('should return connected world for wallet', async () => {
    const { peersRegistry } = stubComponents
    const wallet = '0xtest'
    const world = 'test-world'

    peersRegistry.getPeerWorld.withArgs(wallet).returns(world)

    const response = await makeRequest(wallet)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      wallet,
      world
    })
  })

  it('should return 404 when wallet is not connected', async () => {
    const response = await makeRequest('0xnonexistent')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      message: 'Wallet 0xnonexistent is not connected to any world'
    })
  })
})
