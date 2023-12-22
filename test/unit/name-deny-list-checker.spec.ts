import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createNameDenyListChecker } from '../../src/adapters/name-deny-list-checker'
import { createFetchComponent } from '@dcl/platform-server-commons'

describe('name deny list checker', function () {
  let logs: ILoggerComponent
  let config: IConfigComponent

  beforeEach(async () => {
    config = createConfigComponent({
      DCL_LISTS_URL: 'https://some-api.dcl.net',
      LOG_LEVEL: 'DEBUG'
    })
    logs = await createLogComponent({ config })
  })

  it('when no url provided, it creates a component that does not validate anything, always accepts the names', async () => {
    config = createConfigComponent({
      LOG_LEVEL: 'DEBUG'
    })
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockRejectedValue('should never be called')

    const nameDenyListChecker = await createNameDenyListChecker({
      config,
      logs,
      fetch
    })
    await expect(nameDenyListChecker.checkNameDenyList('banned-name.dcl.eth')).resolves.toBeTruthy()
    await expect(nameDenyListChecker.checkNameDenyList('good-name.dcl.eth')).resolves.toBeTruthy()
  })

  it('does the right validation depending on the obtained list', async () => {
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: ['banned-name']
        })
    })
    const nameDenyListChecker = await createNameDenyListChecker({
      config,
      logs,
      fetch
    })

    await expect(nameDenyListChecker.checkNameDenyList('banned-name.dcl.eth')).resolves.toBeFalsy()
    await expect(nameDenyListChecker.checkNameDenyList('good-name.dcl.eth')).resolves.toBeTruthy()
  })

  it('should correctly reject ENS banned names', async () => {
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: ['banned-name']
        })
    })
    const nameDenyListChecker = await createNameDenyListChecker({
      config,
      logs,
      fetch
    })

    await expect(nameDenyListChecker.checkNameDenyList('banned-name.eth')).resolves.toBeFalsy()
    await expect(nameDenyListChecker.checkNameDenyList('good-name.eth')).resolves.toBeTruthy()
  })
})
