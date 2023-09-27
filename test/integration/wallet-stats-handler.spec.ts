import { test } from '../components'
import { getIdentity } from '../utils'

test('wallet stats handler /wallet/:wallet/stats', function ({ components, stubComponents }) {
  it('correctly returns the aggregated data', async () => {
    const { localFetch, worldCreator } = components

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene({
      owner: identity.authChain
    })

    await worldCreator.createWorldWithScene({
      worldName: 'ens-name.eth',
      owner: identity.authChain
    })

    stubComponents.walletStats.get.resolves({
      wallet: identity.realAccount.address,
      dclNames: [{ name: worldName, size: 18n * 1024n * 1024n }],
      ensNames: [{ name: 'ens-name.eth', size: 3n * 1024n * 1024n }],
      usedSpace: 18n * 1024n * 1024n,
      maxAllowedSpace: 100n * 1024n * 1024n
    })

    const r = await localFetch.fetch(`/wallet/${identity.realAccount.address}/stats`)

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      wallet: identity.realAccount.address,
      dclNames: [{ name: worldName, size: (18n * 1024n * 1024n).toString() }],
      ensNames: [{ name: 'ens-name.eth', size: (3n * 1024n * 1024n).toString() }],
      usedSpace: (18n * 1024n * 1024n).toString(),
      maxAllowedSpace: (100n * 1024n * 1024n).toString()
    })
  })
})
