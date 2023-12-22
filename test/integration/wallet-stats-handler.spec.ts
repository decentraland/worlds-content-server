import { test } from '../components'
import { getIdentity } from '../utils'
import { MB_BigInt } from '../../src/types'

test('wallet stats handler /wallet/:wallet/stats', function ({ components, stubComponents }) {
  it("returns an error when request doesn't include a valid wallet address", async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/wallet/0x123/stats')

    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({
      error: 'Bad request',
      message: 'Invalid request. Missing or invalid wallet in request url param.'
    })
  })

  it('correctly returns the aggregated data', async () => {
    const { localFetch, worldCreator } = components

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene({
      owner: identity.authChain
    })

    await worldCreator.createWorldWithScene({
      worldName: 'ensname.eth',
      owner: identity.authChain
    })

    stubComponents.walletStats.get.resolves({
      wallet: identity.realAccount.address,
      dclNames: [{ name: worldName, size: 18n * MB_BigInt }],
      ensNames: [{ name: 'ensname.eth', size: 3n * MB_BigInt }],
      usedSpace: 18n * MB_BigInt,
      maxAllowedSpace: 100n * MB_BigInt
    })

    const r = await localFetch.fetch(`/wallet/${identity.realAccount.address}/stats`)

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      wallet: identity.realAccount.address,
      dclNames: [{ name: worldName, size: (18n * MB_BigInt).toString() }],
      ensNames: [{ name: 'ensname.eth', size: (3n * MB_BigInt).toString() }],
      usedSpace: (18n * MB_BigInt).toString(),
      maxAllowedSpace: (100n * MB_BigInt).toString()
    })
  })
})
