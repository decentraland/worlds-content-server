import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { EntityType } from '@dcl/schemas'
import { getWorldLimitsHandler } from '../../src/controllers/handlers/world-limits-handler'
import { createLimitsManagerComponent } from '../../src/adapters/limits-manager'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { loadUploadLimits } from '../../src/logic/upload-limits'
import { createValidateSceneDimensions, createValidateSize } from '../../src/logic/validations/scene'
import { DeploymentToValidate, MB_BigInt, ValidatorComponents, Whitelist } from '../../src/types'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'
import { createMockWalletStatsComponent } from '../mocks/wallet-stats-mock'
import { createMockWhitelistComponent } from '../mocks/whitelist-mock'
import { createMockedWorldsManager } from '../mocks/worlds-manager-mock'
import { createDeploymentProcessingMock } from '../mocks/deployment-processing-mock'

const OWNER = '0x1234567890123456789012345678901234567890'
const CONTENT_HASH = 'bafkreigdnbrvuhw2tmvf4ofmhxsjf5k5lfrzo7jrxfl5grlnyctwzvayra'

type WorldKind = {
  kind: string
  worldName: string
  ignoreNameOwnership: boolean
  whitelist: Whitelist
  usedSpace: bigint
  creditedBack: bigint
  expectedMaxSceneSizeInBytes: bigint
}

/** A scene deployment to `parcels` whose content totals `size` bytes, sized from known file infos. */
function buildDeployment(worldName: string, parcels: string[], size: number): DeploymentToValidate {
  return {
    entity: {
      id: 'bafkreientity',
      version: 'v3',
      type: EntityType.SCENE,
      pointers: parcels,
      timestamp: Date.now(),
      content: [{ file: 'scene.bin', hash: CONTENT_HASH }],
      metadata: { worldConfiguration: { name: worldName } }
    },
    files: new Map(),
    authChain: [],
    contentHashesInStorage: new Map([[CONTENT_HASH, true]]),
    contentFileInfos: new Map([[CONTENT_HASH, { size }]])
  }
}

function parcelRow(count: number): string[] {
  return Array.from({ length: count }, (_, x) => `${x},0`)
}

// Each kind takes a different branch of the limits manager.
const worldKinds: WorldKind[] = [
  {
    kind: 'a DCL name bounded by the owner remaining allowance',
    worldName: 'Allowance.dcl.eth',
    ignoreNameOwnership: false,
    whitelist: {},
    usedSpace: 150n * MB_BigInt,
    creditedBack: 7n * MB_BigInt,
    expectedMaxSceneSizeInBytes: 57n * MB_BigInt
  },
  {
    kind: 'a DCL name bounded by the per-scene cap',
    worldName: 'roomy.dcl.eth',
    ignoreNameOwnership: false,
    whitelist: {},
    usedSpace: 0n,
    creditedBack: 0n,
    expectedMaxSceneSizeInBytes: 120n * MB_BigInt
  },
  {
    kind: 'an ENS name',
    worldName: 'someone.eth',
    ignoreNameOwnership: false,
    whitelist: {},
    usedSpace: 0n,
    creditedBack: 0n,
    expectedMaxSceneSizeInBytes: 36n * MB_BigInt
  },
  {
    kind: 'a whitelisted name',
    worldName: 'purchased.dcl.eth',
    ignoreNameOwnership: false,
    whitelist: { 'purchased.dcl.eth': { max_parcels: 9, max_size_in_mb: 160, allow_sdk6: false } },
    usedSpace: 0n,
    creditedBack: 0n,
    expectedMaxSceneSizeInBytes: 160n * MB_BigInt
  },
  {
    kind: 'a world deployed while name ownership validation is ignored',
    worldName: 'anything.dcl.eth',
    ignoreNameOwnership: true,
    whitelist: {},
    usedSpace: 0n,
    creditedBack: 0n,
    expectedMaxSceneSizeInBytes: 100n * MB_BigInt
  }
]

describe.each(worldKinds)('when the limits of $kind are compared with the deployment validation', (world) => {
  let maxSceneSizeInBytes: number
  let maxParcels: number
  let sizeAtLimitOk: boolean
  let sizeOverLimitOk: boolean
  let parcelsAtLimitOk: boolean
  let parcelsOverLimitOk: boolean

  beforeEach(async () => {
    const parcels = ['0,0', '0,1']
    const config = createConfigComponent({
      MAX_PARCELS: '4',
      MAX_SIZE: '100',
      ENS_MAX_SIZE: '36',
      ALLOW_SDK6: 'false',
      MAX_SCENE_SIZE: '120',
      ...(world.ignoreNameOwnership ? { IGNORE_NAME_OWNERSHIP_VALIDATION: 'true' } : {})
    })
    const nameOwnership = createMockedNameOwnership()
    nameOwnership.findOwners.mockResolvedValue(new Map([[world.worldName.toLowerCase(), OWNER]]))
    const walletStats = createMockWalletStatsComponent(
      new Map([
        [
          OWNER,
          {
            wallet: OWNER,
            dclNames: [{ name: world.worldName.toLowerCase(), size: world.creditedBack }],
            ensNames: [],
            usedSpace: world.usedSpace,
            maxAllowedSpace: 200n * MB_BigInt
          }
        ]
      ])
    )
    const worldsManager = createMockedWorldsManager()
    worldsManager.getDeployedSceneSizeForParcels.mockResolvedValue(world.creditedBack)
    const coordinates = createCoordinatesComponent()
    const limitsManager = await createLimitsManagerComponent({
      config,
      nameOwnership,
      uploadLimits: await loadUploadLimits(config),
      walletStats,
      whitelist: createMockWhitelistComponent(world.whitelist),
      worldsManager
    })
    const validatorComponents = {
      coordinates,
      deploymentProcessing: createDeploymentProcessingMock(),
      limitsManager,
      storage: createInMemoryStorage()
    } as unknown as ValidatorComponents

    const response = await getWorldLimitsHandler({
      components: { coordinates, limitsManager },
      params: { world_name: world.worldName },
      url: new URL(`http://localhost/world/${world.worldName}/limits?${parcels.map((p) => `parcels=${p}`).join('&')}`)
    })
    const body = response.body as { maxSceneSizeInBytes: string; maxParcels: number }
    maxSceneSizeInBytes = Number(body.maxSceneSizeInBytes)
    maxParcels = body.maxParcels

    const validateSize = createValidateSize(validatorComponents)
    const validateDimensions = createValidateSceneDimensions(validatorComponents)
    sizeAtLimitOk = (await validateSize(buildDeployment(world.worldName, parcels, maxSceneSizeInBytes))).ok()
    sizeOverLimitOk = (await validateSize(buildDeployment(world.worldName, parcels, maxSceneSizeInBytes + 1))).ok()
    parcelsAtLimitOk = (await validateDimensions(buildDeployment(world.worldName, parcelRow(maxParcels), 1))).ok()
    parcelsOverLimitOk = (await validateDimensions(buildDeployment(world.worldName, parcelRow(maxParcels + 1), 1))).ok()
  })

  it('should return the size limit of its kind', () => {
    expect(maxSceneSizeInBytes).toBe(Number(world.expectedMaxSceneSizeInBytes))
  })

  it('should accept a deployment of exactly the returned size limit', () => {
    expect(sizeAtLimitOk).toBe(true)
  })

  it('should reject a deployment one byte over the returned size limit', () => {
    expect(sizeOverLimitOk).toBe(false)
  })

  it('should accept a deployment of exactly the returned parcel limit', () => {
    expect(parcelsAtLimitOk).toBe(true)
  })

  it('should reject a deployment one parcel over the returned parcel limit', () => {
    expect(parcelsOverLimitOk).toBe(false)
  })
})
