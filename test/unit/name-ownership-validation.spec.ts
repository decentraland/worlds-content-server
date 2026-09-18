import { createConfigComponent } from '@well-known-components/env-config-provider'
import { isNameOwnershipValidationIgnored } from '../../src/logic/name-ownership-validation'

describe('name ownership validation configuration', () => {
  it('is disabled when the variable is absent', async () => {
    await expect(isNameOwnershipValidationIgnored(createConfigComponent({}))).resolves.toBe(false)
  })

  it('is enabled only for the explicit lowercase true value', async () => {
    await expect(
      isNameOwnershipValidationIgnored(createConfigComponent({ IGNORE_NAME_OWNERSHIP_VALIDATION: 'true' }))
    ).resolves.toBe(true)
    await expect(
      isNameOwnershipValidationIgnored(createConfigComponent({ IGNORE_NAME_OWNERSHIP_VALIDATION: 'TRUE' }))
    ).resolves.toBe(false)
  })
})
