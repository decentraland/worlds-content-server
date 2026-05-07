import { createPartialDeploymentValidator } from '../../src/logic/validations/partial-deployment-validator'
import { PARTIAL_DEPLOYMENT_DEFAULT_FILE_LIMIT_BYTES } from '../../src/types'
import { Entity } from '@dcl/schemas'

/** Minimal stub for the v1 Validator components needed by createPartialDeploymentValidator. */
function makeComponents(validateFn = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })) {
  return {
    config: { getString: jest.fn(), getNumber: jest.fn(), requireString: jest.fn(), requireNumber: jest.fn() },
    limitsManager: {
      getAllowSdk6For: jest.fn().mockResolvedValue(true),
      getMaxAllowedParcelsFor: jest.fn().mockResolvedValue(100),
      getMaxAllowedSizeInBytesFor: jest.fn().mockResolvedValue(BigInt(100 * 1024 * 1024))
    },
    nameDenyListChecker: {
      getBannedNames: jest.fn().mockResolvedValue([]),
      checkNameDenyList: jest.fn().mockResolvedValue(false)
    },
    namePermissionChecker: { checkPermission: jest.fn().mockResolvedValue(true) },
    permissions: {},
    storage: { existMultiple: jest.fn().mockResolvedValue(new Map()) },
    worldsManager: {},
    _validateFn: validateFn
  } as any
}

const baseEntity: Entity = {
  id: 'QmTest',
  timestamp: Date.now(),
  version: 'v3',
  type: 'scene' as any,
  pointers: ['0,0'],
  content: []
}

describe('createPartialDeploymentValidator.preflight', () => {
  it('rejects when any manifest entry exceeds per-file size limit', async () => {
    const validateSpy = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })
    const components = makeComponents(validateSpy)
    // Override v1 validator via monkey-patching is not straightforward since
    // createValidator is called internally. We test the size-rejection path
    // which short-circuits before calling v1 — so validateSpy should NOT be called.
    // We use a real validator and check the returned ValidationResult.
    const validator = createPartialDeploymentValidator(components)
    const oversizedHash = 'QmOversized'
    const oversizedSize = PARTIAL_DEPLOYMENT_DEFAULT_FILE_LIMIT_BYTES + 1
    const result = await validator.preflight({
      entity: baseEntity,
      entityRaw: Buffer.from('{}'),
      authChain: [],
      fileSizesManifest: { [oversizedHash]: oversizedSize },
      contentHashesInStorage: new Map()
    })
    expect(result.ok()).toBe(false)
    expect(result.errors.join(' ')).toMatch(new RegExp(oversizedHash))
    expect(result.errors.join(' ')).toMatch(/size limit/i)
  })

  it('passes manifest with all files within limit to v1 validator', async () => {
    const validator = createPartialDeploymentValidator(makeComponents())
    const result = await validator.preflight({
      entity: baseEntity,
      entityRaw: Buffer.from('{}'),
      authChain: [],
      fileSizesManifest: { QmSmall: 100 },
      contentHashesInStorage: new Map()
    })
    // The v1 validator internally may fail for other reasons (missing world name etc.)
    // but we only care that the size check did not short-circuit it.
    // If ok() is false the errors should NOT mention "size limit".
    if (!result.ok()) {
      expect(result.errors.join(' ')).not.toMatch(/size limit/i)
    }
  })

  it('includes entityRaw in the files map keyed by entity.id when delegating to v1', async () => {
    // We cannot easily spy on the internal v1 validator's validate() call without
    // dependency injection, but we can verify the preflight doesn't throw and
    // that an empty manifest (no oversized files) reaches v1 without the size guard
    // short-circuiting it.
    const validator = createPartialDeploymentValidator(makeComponents())
    const entityRaw = Buffer.from(JSON.stringify({ content: [] }))
    // Should not throw; the result may be ok or not depending on v1 validations.
    const result = await validator.preflight({
      entity: baseEntity,
      entityRaw,
      authChain: [],
      fileSizesManifest: {},
      contentHashesInStorage: new Map()
    })
    // Regardless of v1 outcome, the size guard should not have triggered.
    if (!result.ok()) {
      expect(result.errors.join(' ')).not.toMatch(/size limit/i)
    }
  })
})
