import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createHttpProviderMock } from '../mocks/http-provider-mock'
import { createNameDenyListChecker } from '../../src/adapters/name-deny-list-checker'

describe('name deny list checker', function () {
  let logs: ILoggerComponent
  let config: IConfigComponent

  beforeEach(async () => {
    config = createConfigComponent({
      ETH_NETWORK: 'mainnet',
      LOG_LEVEL: 'DEBUG'
    })
    logs = await createLogComponent({ config })
  })

  it('when invalid network configured, it fails to create component', async () => {
    config = createConfigComponent({
      ETH_NETWORK: 'invalid',
      LOG_LEVEL: 'DEBUG'
    })

    await expect(
      createNameDenyListChecker({
        config,
        logs,
        ethereumProvider: createHttpProviderMock()
      })
    ).rejects.toThrowError('Invalid ETH_NETWORK: invalid')
  })

  it('when on chain validation returns false', async () => {
    const nameDenyListChecker = await createNameDenyListChecker({
      config,
      logs,
      ethereumProvider: createHttpProviderMock([
        { jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        {
          jsonrpc: '2.0',
          id: 2,
          result:
            '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b62616E6E65642D6E616D65000000000000000000000000000000000000000000'
        }
      ])
    })

    await expect(nameDenyListChecker.checkNameDenyList('banned-name.dcl.eth')).resolves.toBeFalsy()
    await expect(nameDenyListChecker.checkNameDenyList('good-name.dcl.eth')).resolves.toBeTruthy()
  })
})
