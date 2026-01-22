import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createNameChecker } from '../../src/adapters/dcl-name-checker'
import { createLogComponent } from '@well-known-components/logger'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { INameOwnership } from '../../src/types'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'

describe('dcl name checker', function () {
  let logs: ILoggerComponent
  let nameOwnership: jest.Mocked<INameOwnership>

  beforeEach(async () => {
    logs = await createLogComponent({
      config: createConfigComponent({
        LOG_LEVEL: 'DEBUG'
      })
    })
    nameOwnership = createMockedNameOwnership()
  })

  describe('when permission asked for invalid name', () => {
    it('should return false', async () => {
      nameOwnership.findOwners.mockResolvedValue(new Map([['', undefined]]))

      const dclNameChecker = createNameChecker({ logs, nameOwnership })

      await expect(dclNameChecker.checkPermission('0xb', '')).resolves.toBeFalsy()
    })
  })

  describe('when called with non-owner address', () => {
    it('should return false', async () => {
      nameOwnership.findOwners.mockResolvedValue(new Map([['my-super-name.dcl.eth', '0xabc']]))

      const dclNameChecker = createNameChecker({ logs, nameOwnership })

      await expect(dclNameChecker.checkPermission('0xdef', 'my-super-name.dcl.eth')).resolves.toBeFalsy()
    })
  })

  describe('when called with owner address', () => {
    it('should return true', async () => {
      nameOwnership.findOwners.mockResolvedValue(new Map([['my-super-name.dcl.eth', '0xabc']]))

      const dclNameChecker = createNameChecker({ logs, nameOwnership })

      await expect(dclNameChecker.checkPermission('0xabc', 'my-super-name.dcl.eth')).resolves.toBeTruthy()
    })
  })
})
