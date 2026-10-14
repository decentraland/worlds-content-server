import { createConfigComponent } from '@well-known-components/env-config-provider'
import { NotFoundError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@dcl/core-commons'
import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { EntityType } from '@dcl/schemas'
import { getWorldLimitsHandler } from '../../src/controllers/handlers/world-limits-handler'
import { createLimitsManagerComponent, WorldOwnerNotFoundError } from '../../src/adapters/limits-manager'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { loadUploadLimits } from '../../src/logic/upload-limits'
import { createValidateSceneDimensions, createValidateSize } from '../../src/logic/validations/scene'
import { DeploymentToValidate, ILimitsManager, MB_BigInt, ValidatorComponents, Whitelist } from '../../src/types'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'
import { createMockWalletStatsComponent } from '../mocks/wallet-stats-mock'
import { createMockWhitelistComponent } from '../mocks/whitelist-mock'
import { createMockNameDenyListChecker } from '../mocks/name-deny-list-checker-mock'
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
  creditsBackOverlappingScenes: boolean
  expectedMaxSceneSizeInBytes: bigint
}

// The canonical parcels a deployment sends as pointers, and non-canonical, duplicated spellings
// of the same parcels a client may send to the endpoint.
const CANONICAL_PARCELS = ['0,0', '0,1']
const ENDPOINT_PARCELS = ['00,00', '0,0', ' 0 , 01 ', '-0,1']

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
    creditsBackOverlappingScenes: true,
    expectedMaxSceneSizeInBytes: 57n * MB_BigInt
  },
  {
    kind: 'a DCL name bounded by the per-scene cap',
    worldName: 'roomy.dcl.eth',
    ignoreNameOwnership: false,
    whitelist: {},
    usedSpace: 0n,
    creditedBack: 0n,
    creditsBackOverlappingScenes: true,
    expectedMaxSceneSizeInBytes: 120n * MB_BigInt
  },
  {
    kind: 'an ENS name',
    worldName: 'someone.eth',
    ignoreNameOwnership: false,
    whitelist: {},
    usedSpace: 0n,
    creditedBack: 0n,
    creditsBackOverlappingScenes: false,
    expectedMaxSceneSizeInBytes: 36n * MB_BigInt
  },
  {
    kind: 'a whitelisted name',
    worldName: 'purchased.dcl.eth',
    ignoreNameOwnership: false,
    whitelist: { 'purchased.dcl.eth': { max_parcels: 9, max_size_in_mb: 160, allow_sdk6: false } },
    usedSpace: 0n,
    creditedBack: 0n,
    creditsBackOverlappingScenes: false,
    expectedMaxSceneSizeInBytes: 160n * MB_BigInt
  },
  {
    kind: 'a world deployed while name ownership validation is ignored',
    worldName: 'anything.dcl.eth',
    ignoreNameOwnership: true,
    whitelist: {},
    usedSpace: 0n,
    creditedBack: 0n,
    creditsBackOverlappingScenes: false,
    expectedMaxSceneSizeInBytes: 100n * MB_BigInt
  }
]

type Setup = {
  coordinates: ReturnType<typeof createCoordinatesComponent>
  limitsManager: ILimitsManager
  worldsManager: ReturnType<typeof createMockedWorldsManager>
  nameOwnership: ReturnType<typeof createMockedNameOwnership>
  validatorComponents: ValidatorComponents
}

/**
 * Wires the real limits manager the way the server does. The owner holds 200MB; `wholeWorldSize`
 * is the world's deployed size and `overlappingSize` the size of the scenes on CANONICAL_PARCELS
 * (any other parcels credit back nothing).
 */
async function setUp(
  world: Pick<WorldKind, 'worldName' | 'ignoreNameOwnership' | 'whitelist' | 'usedSpace'>,
  wholeWorldSize: bigint,
  overlappingSize: bigint
): Promise<Setup> {
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
          dclNames: [{ name: world.worldName.toLowerCase(), size: wholeWorldSize }],
          ensNames: [],
          usedSpace: world.usedSpace,
          maxAllowedSpace: 200n * MB_BigInt
        }
      ]
    ])
  )
  const worldsManager = createMockedWorldsManager()
  worldsManager.getDeployedSceneSizeForParcels.mockImplementation(async (_worldName, parcels) =>
    JSON.stringify(parcels) === JSON.stringify(CANONICAL_PARCELS) ? overlappingSize : 0n
  )
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

  return { coordinates, limitsManager, worldsManager, nameOwnership, validatorComponents }
}

/** Calls the endpoint handler, optionally with repeated `parcels`. */
function fetchLimits(setup: Setup, worldName: string, parcels?: string[]): Promise<IHttpServerComponent.IResponse> {
  const query = parcels ? `?${parcels.map((parcel) => `parcels=${encodeURIComponent(parcel)}`).join('&')}` : ''
  return getWorldLimitsHandler({
    components: {
      coordinates: setup.coordinates,
      limitsManager: setup.limitsManager,
      nameDenyListChecker: createMockNameDenyListChecker()
    },
    params: { world_name: worldName },
    url: new URL(`http://localhost/world/${worldName}/limits${query}`)
  })
}

function readSizeLimit(response: IHttpServerComponent.IResponse): number {
  return Number((response.body as { maxSceneSizeInBytes: string }).maxSceneSizeInBytes)
}

describe.each(worldKinds)('when the limits of $kind are compared with the deployment validation', (world) => {
  let maxSceneSizeInBytes: number
  let maxSceneSizeInBytesWithoutParcels: number
  let maxParcels: number
  let endpointCreditCalls: unknown[][]
  let validatorCreditCalls: unknown[][]
  let sizeAtLimitOk: boolean
  let sizeOverLimitOk: boolean
  let parcelsAtLimitOk: boolean
  let parcelsOverLimitOk: boolean

  beforeEach(async () => {
    const setup = await setUp(world, world.creditedBack, world.creditedBack)

    const response = await fetchLimits(setup, world.worldName, ENDPOINT_PARCELS)
    maxSceneSizeInBytes = readSizeLimit(response)
    maxParcels = (response.body as { maxParcels: number }).maxParcels
    endpointCreditCalls = [...setup.worldsManager.getDeployedSceneSizeForParcels.mock.calls]
    setup.worldsManager.getDeployedSceneSizeForParcels.mockClear()

    const validateSize = createValidateSize(setup.validatorComponents)
    const validateDimensions = createValidateSceneDimensions(setup.validatorComponents)
    sizeAtLimitOk = (await validateSize(buildDeployment(world.worldName, CANONICAL_PARCELS, maxSceneSizeInBytes))).ok()
    validatorCreditCalls = [...setup.worldsManager.getDeployedSceneSizeForParcels.mock.calls]
    sizeOverLimitOk = (
      await validateSize(buildDeployment(world.worldName, CANONICAL_PARCELS, maxSceneSizeInBytes + 1))
    ).ok()
    parcelsAtLimitOk = (await validateDimensions(buildDeployment(world.worldName, parcelRow(maxParcels), 1))).ok()
    parcelsOverLimitOk = (await validateDimensions(buildDeployment(world.worldName, parcelRow(maxParcels + 1), 1))).ok()

    maxSceneSizeInBytesWithoutParcels = readSizeLimit(await fetchLimits(setup, world.worldName))
  })

  it('should return the size limit of its kind', () => {
    expect(maxSceneSizeInBytes).toBe(Number(world.expectedMaxSceneSizeInBytes))
  })

  it('should credit back the scenes on the same canonical parcels the deployment validation does', () => {
    expect(endpointCreditCalls).toEqual(validatorCreditCalls)
  })

  it('should credit back the overlapping scenes only when the size depends on the owner allowance', () => {
    expect(validatorCreditCalls).toEqual(
      world.creditsBackOverlappingScenes ? [[world.worldName.toLowerCase(), CANONICAL_PARCELS]] : []
    )
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

  it('should return the same size limit without parcels when the deployment replaces the whole world', () => {
    expect(maxSceneSizeInBytesWithoutParcels).toBe(maxSceneSizeInBytes)
  })
})

describe('when the limits of a world with scenes outside the requested parcels are compared with the deployment validation', () => {
  let maxSceneSizeInBytes: number
  let maxSceneSizeInBytesWithoutParcels: number
  let sizeAtLimitOk: boolean
  let sizeAtLimitWithoutParcelsOk: boolean

  beforeEach(async () => {
    const world = worldKinds[0]
    // 20MB deployed in the world, 7MB of it on the requested parcels.
    const setup = await setUp(world, 20n * MB_BigInt, 7n * MB_BigInt)
    maxSceneSizeInBytes = readSizeLimit(await fetchLimits(setup, world.worldName, ENDPOINT_PARCELS))
    maxSceneSizeInBytesWithoutParcels = readSizeLimit(await fetchLimits(setup, world.worldName))

    const validateSize = createValidateSize(setup.validatorComponents)
    sizeAtLimitOk = (await validateSize(buildDeployment(world.worldName, CANONICAL_PARCELS, maxSceneSizeInBytes))).ok()
    sizeAtLimitWithoutParcelsOk = (
      await validateSize(buildDeployment(world.worldName, CANONICAL_PARCELS, maxSceneSizeInBytesWithoutParcels))
    ).ok()
  })

  it('should return a size limit without parcels that credits back the whole world', () => {
    expect(maxSceneSizeInBytesWithoutParcels).toBe(Number(70n * MB_BigInt))
  })

  it('should return a size limit with parcels that credits back only the overlapping scenes', () => {
    expect(maxSceneSizeInBytes).toBe(Number(57n * MB_BigInt))
  })

  it('should accept a deployment of exactly the size limit returned for its parcels', () => {
    expect(sizeAtLimitOk).toBe(true)
  })

  it('should reject a deployment of the size limit returned without parcels, as it is an upper bound', () => {
    expect(sizeAtLimitWithoutParcelsOk).toBe(false)
  })
})

describe('when the limits of a world whose owner cannot be determined are compared with the deployment validation', () => {
  let endpointError: unknown
  let validatorError: unknown

  beforeEach(async () => {
    const world = worldKinds[0]
    const setup = await setUp(world, 0n, 0n)
    setup.nameOwnership.findOwners.mockResolvedValue(new Map())

    endpointError = await fetchLimits(setup, world.worldName, ENDPOINT_PARCELS).catch((error) => error)
    validatorError = await createValidateSize(setup.validatorComponents)(
      buildDeployment(world.worldName, CANONICAL_PARCELS, 1)
    ).catch((error) => error)
  })

  it('should fail the endpoint with a not found error', () => {
    expect(endpointError).toEqual(new NotFoundError('Could not determine owner for world allowance.dcl.eth'))
  })

  it('should fail the deployment validation with the owner not found error', () => {
    expect(validatorError).toEqual(new WorldOwnerNotFoundError('allowance.dcl.eth'))
  })
})
