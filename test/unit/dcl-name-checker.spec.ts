import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createNameChecker } from '../../src/adapters/dcl-name-checker'
import { createLogComponent } from '@well-known-components/logger'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { INameOwnership } from '../../src/types'

function createMockNameOwnership(owner: string | undefined = undefined): INameOwnership {
  return {
    findOwner: () => Promise.resolve(owner)
  }
}

describe('dcl name checker', function () {
  let logs: ILoggerComponent

  beforeEach(async () => {
    logs = await createLogComponent({
      config: createConfigComponent({
        LOG_LEVEL: 'DEBUG'
      })
    })
  })

  it('when permission asked for invalid name it returns false', async () => {
    const dclNameChecker = createNameChecker({
      logs,
      nameOwnership: createMockNameOwnership()
    })

    await expect(dclNameChecker.checkPermission('0xb', '')).resolves.toBeFalsy()
  })

  it('when called with non-owner address it returns false', async () => {
    const dclNameChecker = createNameChecker({
      logs,
      nameOwnership: createMockNameOwnership('0xabc')
    })

    await expect(dclNameChecker.checkPermission('0xdef', 'my-super-name.dcl.eth')).resolves.toBeFalsy()
  })

  it('when called with owner address it returns true', async () => {
    const dclNameChecker = createNameChecker({
      logs,
      nameOwnership: createMockNameOwnership('0xabc')
    })

    await expect(dclNameChecker.checkPermission('0xabc', 'my-super-name.dcl.eth')).resolves.toBeTruthy()
  })
})
