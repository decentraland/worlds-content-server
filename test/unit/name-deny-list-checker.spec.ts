import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createNameDenyListChecker } from '../../src/adapters/name-deny-list-checker'
import { createFetchComponent } from '../../src/adapters/fetch'

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

  it('blocks exact configured world names without a remote service, preserving unrelated names', async () => {
    config = createConfigComponent({
      BLOCKED_WORLD_NAMES: ' Blocked.dcl.eth, , Other.eth,blocked.dcl.eth, '
    })
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockRejectedValue(new Error('should never be called'))
    const checker = await createNameDenyListChecker({ config, logs, fetch })

    await expect(checker.checkNameDenyList('BLOCKED.dcl.eth')).resolves.toBe(false)
    await expect(checker.checkNameDenyList('other.eth')).resolves.toBe(false)
    await expect(checker.checkNameDenyList('blocked.eth')).resolves.toBe(true)
    await expect(checker.checkNameDenyList('good.dcl.eth')).resolves.toBe(true)
    await expect(checker.getBannedNames()).resolves.toEqual(['blocked.dcl.eth', 'other.eth'])
    expect(fetch.fetch).not.toHaveBeenCalled()
  })

  it('keeps configured blocks effective when the remote list is unavailable', async () => {
    config = createConfigComponent({
      BLOCKED_WORLD_NAMES: 'blocked.dcl.eth',
      DCL_LISTS_URL: 'https://some-api.dcl.net'
    })
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockRejectedValue(new Error('offline'))
    const checker = await createNameDenyListChecker({ config, logs, fetch })

    await expect(checker.checkNameDenyList('blocked.dcl.eth')).resolves.toBe(false)
    expect(fetch.fetch).not.toHaveBeenCalled()
    await expect(checker.getBannedNames()).resolves.toContain('blocked.dcl.eth')
    await expect(checker.checkNameDenyList('blocked.dcl.eth')).resolves.toBe(false)
  })

  it('adds configured blocks without replacing the remote denylist', async () => {
    config = createConfigComponent({
      BLOCKED_WORLD_NAMES: 'blocked.dcl.eth',
      DCL_LISTS_URL: 'https://some-api.dcl.net'
    })
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockResolvedValue({ json: async () => ({ data: ['remote-banned'] }) })
    const checker = await createNameDenyListChecker({ config, logs, fetch })

    await expect(checker.checkNameDenyList('remote-banned.dcl.eth')).resolves.toBe(false)
    await expect(checker.checkNameDenyList('blocked.dcl.eth')).resolves.toBe(false)
    await expect(checker.getBannedNames()).resolves.toEqual(['blocked.dcl.eth', 'remote-banned'])
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

  it('when the fetched list contains null or non-string entries, it ignores them instead of crashing', async () => {
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: ['banned-name', null, undefined, 42, 'another-banned']
        })
    })
    const nameDenyListChecker = await createNameDenyListChecker({
      config,
      logs,
      fetch
    })

    await expect(nameDenyListChecker.checkNameDenyList('good-name.dcl.eth')).resolves.toBeTruthy()
    await expect(nameDenyListChecker.checkNameDenyList('banned-name.dcl.eth')).resolves.toBeFalsy()
    await expect(nameDenyListChecker.getBannedNames()).resolves.toEqual(['banned-name', 'another-banned'])
  })

  it('when the fetched payload has no array data, it degrades to an empty list', async () => {
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: null })
    })
    const nameDenyListChecker = await createNameDenyListChecker({
      config,
      logs,
      fetch
    })

    await expect(nameDenyListChecker.checkNameDenyList('any-name.dcl.eth')).resolves.toBeTruthy()
    await expect(nameDenyListChecker.getBannedNames()).resolves.toEqual([])
  })

  it('when fetch fails, it gracefully degrades and allows all names', async () => {
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockRejectedValue(new Error('Premature close'))

    const nameDenyListChecker = await createNameDenyListChecker({
      config,
      logs,
      fetch
    })
    await expect(nameDenyListChecker.checkNameDenyList('any-name.dcl.eth')).resolves.toBeTruthy()
  })

  it('should reject a banned name regardless of the case it is deployed with', async () => {
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

    await expect(nameDenyListChecker.checkNameDenyList('Banned-Name.dcl.eth')).resolves.toBeFalsy()
    await expect(nameDenyListChecker.checkNameDenyList('BANNED-NAME.eth')).resolves.toBeFalsy()
  })
})
