import { createConfigComponent } from '@well-known-components/env-config-provider'
import { InvalidRequestError, NotFoundError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@dcl/core-commons'
import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { EntityType } from '@dcl/schemas'
import { getWorldLimitsHandler } from '../../src/controllers/handlers/world-limits-handler'
import { createLimitsManagerComponent, WorldOwnerNotFoundError } from '../../src/adapters/limits-manager'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { loadUploadLimits } from '../../src/logic/upload-limits'
import {
  createValidateParcelCoordinates,
  createValidateSceneDimensions,
  createValidateScenePointers,
  createValidateSize
} from '../../src/logic/validations/scene'
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
  expectedCreditBackLookups: unknown[][]
  expectedMaxSceneSizeInBytes: bigint
  expectedMaxSceneSizeInBytesWithoutParcels: bigint
}

// The parcels of the scene, sent both as the deployment's pointers and as the endpoint's parcels.
const SCENE_PARCELS = ['0,0', '0,1']
// The world's deployed size and the part of it on SCENE_PARCELS. They differ, so crediting back
// the whole world or only the overlapping scenes gives different limits.
const WHOLE_WORLD_SIZE = 20n * MB_BigInt
const OVERLAPPING_SIZE = 7n * MB_BigInt

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

// Each kind takes a different branch of the limits manager. Only DCL names bounded by the owner
// allowance credit back the deployed scenes; the other kinds have a fixed cap.
const worldKinds: WorldKind[] = [
  {
    kind: 'a DCL name bounded by the owner remaining allowance',
    worldName: 'Allowance.dcl.eth',
    ignoreNameOwnership: false,
    whitelist: {},
    usedSpace: 150n * MB_BigInt,
    expectedCreditBackLookups: [['allowance.dcl.eth', SCENE_PARCELS]],
    expectedMaxSceneSizeInBytes: 57n * MB_BigInt,
    expectedMaxSceneSizeInBytesWithoutParcels: 70n * MB_BigInt
  },
  {
    kind: 'a DCL name bounded by the per-scene cap',
    worldName: 'roomy.dcl.eth',
    ignoreNameOwnership: false,
    whitelist: {},
    usedSpace: 20n * MB_BigInt,
    expectedCreditBackLookups: [['roomy.dcl.eth', SCENE_PARCELS]],
    expectedMaxSceneSizeInBytes: 120n * MB_BigInt,
    expectedMaxSceneSizeInBytesWithoutParcels: 120n * MB_BigInt
  },
  {
    kind: 'an ENS name',
    worldName: 'someone.eth',
    ignoreNameOwnership: false,
    whitelist: {},
    usedSpace: 20n * MB_BigInt,
    expectedCreditBackLookups: [],
    expectedMaxSceneSizeInBytes: 36n * MB_BigInt,
    expectedMaxSceneSizeInBytesWithoutParcels: 36n * MB_BigInt
  },
  {
    kind: 'a whitelisted name',
    worldName: 'purchased.dcl.eth',
    ignoreNameOwnership: false,
    whitelist: { 'purchased.dcl.eth': { max_parcels: 9, max_size_in_mb: 160, allow_sdk6: false } },
    usedSpace: 20n * MB_BigInt,
    expectedCreditBackLookups: [],
    expectedMaxSceneSizeInBytes: 160n * MB_BigInt,
    expectedMaxSceneSizeInBytesWithoutParcels: 160n * MB_BigInt
  },
  {
    kind: 'a world deployed while name ownership validation is ignored',
    worldName: 'anything.dcl.eth',
    ignoreNameOwnership: true,
    whitelist: {},
    usedSpace: 20n * MB_BigInt,
    expectedCreditBackLookups: [],
    expectedMaxSceneSizeInBytes: 100n * MB_BigInt,
    expectedMaxSceneSizeInBytesWithoutParcels: 100n * MB_BigInt
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
 * is the world's deployed size and `overlappingSize` the size of the scenes on SCENE_PARCELS
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
  // Credits back by parcel set, so the order the parcels arrive in doesn't matter
  const sceneParcelSet = [...SCENE_PARCELS].sort().join('|')
  worldsManager.getDeployedSceneSizeForParcels.mockImplementation(async (_worldName, parcels) =>
    [...parcels].sort().join('|') === sceneParcelSet ? overlappingSize : 0n
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
  let sizeAtLimitWithoutParcelsOk: boolean
  let sizeOverLimitOk: boolean
  let parcelsAtLimitOk: boolean
  let parcelsOverLimitOk: boolean

  beforeEach(async () => {
    const setup = await setUp(world, WHOLE_WORLD_SIZE, OVERLAPPING_SIZE)

    const response = await fetchLimits(setup, world.worldName, SCENE_PARCELS)
    maxSceneSizeInBytes = readSizeLimit(response)
    maxParcels = (response.body as { maxParcels: number }).maxParcels
    endpointCreditCalls = [...setup.worldsManager.getDeployedSceneSizeForParcels.mock.calls]
    setup.worldsManager.getDeployedSceneSizeForParcels.mockClear()

    const validateSize = createValidateSize(setup.validatorComponents)
    const validateDimensions = createValidateSceneDimensions(setup.validatorComponents)
    sizeAtLimitOk = (await validateSize(buildDeployment(world.worldName, SCENE_PARCELS, maxSceneSizeInBytes))).ok()
    validatorCreditCalls = [...setup.worldsManager.getDeployedSceneSizeForParcels.mock.calls]
    sizeOverLimitOk = (
      await validateSize(buildDeployment(world.worldName, SCENE_PARCELS, maxSceneSizeInBytes + 1))
    ).ok()
    parcelsAtLimitOk = (await validateDimensions(buildDeployment(world.worldName, parcelRow(maxParcels), 1))).ok()
    parcelsOverLimitOk = (await validateDimensions(buildDeployment(world.worldName, parcelRow(maxParcels + 1), 1))).ok()

    maxSceneSizeInBytesWithoutParcels = readSizeLimit(await fetchLimits(setup, world.worldName))
    sizeAtLimitWithoutParcelsOk = (
      await validateSize(buildDeployment(world.worldName, SCENE_PARCELS, maxSceneSizeInBytesWithoutParcels))
    ).ok()
  })

  it('should return the size limit of its kind', () => {
    expect(maxSceneSizeInBytes).toBe(Number(world.expectedMaxSceneSizeInBytes))
  })

  it('should look up the deployed scenes to credit back for the endpoint only when the size depends on the owner allowance', () => {
    expect(endpointCreditCalls).toEqual(world.expectedCreditBackLookups)
  })

  it('should look up the same deployed scenes to credit back for the deployment validation', () => {
    expect(validatorCreditCalls).toEqual(world.expectedCreditBackLookups)
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

  it('should return the size limit of its kind without parcels', () => {
    expect(maxSceneSizeInBytesWithoutParcels).toBe(Number(world.expectedMaxSceneSizeInBytesWithoutParcels))
  })

  it('should accept a deployment of the size limit returned without parcels only when it is not over the limit for its parcels', () => {
    expect(sizeAtLimitWithoutParcelsOk).toBe(
      world.expectedMaxSceneSizeInBytesWithoutParcels <= world.expectedMaxSceneSizeInBytes
    )
  })
})

describe('when the limits of a world whose owner cannot be determined are compared with the deployment validation', () => {
  let endpointError: unknown
  let validatorError: unknown

  beforeEach(async () => {
    const world = worldKinds[0]
    const setup = await setUp(world, 0n, 0n)
    setup.nameOwnership.findOwners.mockResolvedValue(new Map())

    endpointError = await fetchLimits(setup, world.worldName, SCENE_PARCELS).catch((error) => error)
    validatorError = await createValidateSize(setup.validatorComponents)(
      buildDeployment(world.worldName, SCENE_PARCELS, 1)
    ).catch((error) => error)
  })

  it('should fail the endpoint with a not found error', () => {
    expect(endpointError).toEqual(new NotFoundError('Could not determine owner for world allowance.dcl.eth'))
  })

  it('should fail the deployment validation with the owner not found error', () => {
    expect(validatorError).toEqual(new WorldOwnerNotFoundError('allowance.dcl.eth'))
  })
})

describe.each([
  ['unique canonical parcels', ['0,0', '0,1', '-1,0'], false],
  ['a repeated parcel', ['0,0', '0,1', '0,0'], true],
  ['a parcel with a signed zero', ['-0,1'], true],
  ['a parcel with a leading zero', ['01,0'], true],
  ['a parcel with whitespace', [' 0,0'], true],
  ['a parcel with a non-integer coordinate', ['1.5,0'], true],
  ['a parcel with trailing non-digit characters', ['1abc,2'], true],
  ['an empty parcel', [''], true],
  ['a parcel out of bounds', ['151,0'], true]
])('when the limits for %s are compared with the deployment pointer validation', (_case, parcels, rejected) => {
  let endpointRejected: boolean
  let deploymentRejected: boolean

  beforeEach(async () => {
    const world = worldKinds[0]
    const setup = await setUp(world, 0n, 0n)
    const deployment = buildDeployment(world.worldName, parcels, 1)
    deployment.entity.metadata.scene = { base: parcels[0], parcels }

    endpointRejected = await fetchLimits(setup, world.worldName, parcels).then(
      () => false,
      (error) => error instanceof InvalidRequestError
    )
    const pointersOk = (await createValidateScenePointers(setup.validatorComponents)(deployment)).ok()
    const coordinatesOk = (await createValidateParcelCoordinates(setup.validatorComponents)(deployment)).ok()
    deploymentRejected = !pointersOk || !coordinatesOk
  })

  it(`should ${rejected ? 'reject' : 'accept'} them in the deployment validation`, () => {
    expect(deploymentRejected).toBe(rejected)
  })

  it(`should ${rejected ? 'reject' : 'accept'} them in the endpoint`, () => {
    expect(endpointRejected).toBe(rejected)
  })
})
