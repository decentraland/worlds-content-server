import { Request, Response } from 'node-fetch'
import { createLimitsManagerComponent } from '../../src/adapters/limits-manager'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IFetchComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createMockNameOwnership } from '../mocks/name-ownership-mock'
import { createMockWalletStatsComponent } from '../mocks/wallet-stats-mock'
import { EthAddress } from '@dcl/schemas'
import { WalletStats } from '../../src/types'

describe('limits manager', function () {
  it('fetches and updates config', async () => {
    const config = createConfigComponent({
      MAX_PARCELS: '4',
      MAX_SIZE: '200',
      ENS_MAX_SIZE: '25',
      ALLOW_SDK6: 'false',
      WHITELIST_URL: 'http://localhost/whitelist.json'
    })

    const fetch: IFetchComponent = {
      fetch: async (_url: Request): Promise<Response> =>
        new Response(
          JSON.stringify({
            'purchased.dcl.eth': {
              max_parcels: 44,
              max_size_in_mb: 160,
              allow_sdk6: true
            }
          })
        )
    }

    const logs = await createLogComponent({})

    const nameOwnership = createMockNameOwnership(new Map([['whatever.dcl.eth', '0x123']]))
    const walletStats = createMockWalletStatsComponent(
      new Map<EthAddress, WalletStats>([
        [
          '0x123',
          {
            wallet: '0x123',
            dclNames: [{ name: 'whatever.dcl.eth', size: 10n }],
            ensNames: [],
            usedSpace: 10n,
            maxAllowedSpace: 200n
          }
        ]
      ])
    )

    const limitsManager = await createLimitsManagerComponent({
      config,
      fetch,
      logs,
      nameOwnership,
      walletStats
    })

    // When whitelisted
    expect(await limitsManager.getAllowSdk6For('purchased.dcl.eth')).toBeTruthy()
    expect(await limitsManager.getMaxAllowedSizeInBytesFor('purchased.dcl.eth')).toBe(160n)
    expect(await limitsManager.getMaxAllowedParcelsFor('purchased.dcl.eth')).toBe(44)

    // When ENS
    expect(await limitsManager.getAllowSdk6For('cool.eth')).toBeFalsy()
    expect(await limitsManager.getMaxAllowedSizeInBytesFor('cool.eth')).toBe(25n)
    expect(await limitsManager.getMaxAllowedParcelsFor('cool.eth')).toBe(4)

    expect(await limitsManager.getAllowSdk6For('no-owner.dcl.eth')).toBeFalsy()
    await expect(limitsManager.getMaxAllowedSizeInBytesFor('no-owner.dcl.eth')).rejects.toThrowError(
      'Could not determine owner for world no-owner.dcl.eth'
    )
    expect(await limitsManager.getMaxAllowedParcelsFor('no-owner.dcl.eth')).toBe(4)

    // When default
    expect(await limitsManager.getAllowSdk6For('whatever.dcl.eth')).toBeFalsy()
    expect(await limitsManager.getMaxAllowedSizeInBytesFor('whatever.dcl.eth')).toBe(200n)
    expect(await limitsManager.getMaxAllowedParcelsFor('whatever.dcl.eth')).toBe(4)
  })
})
