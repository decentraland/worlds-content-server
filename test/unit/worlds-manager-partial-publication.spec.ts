import { AuthLinkType, Entity, EntityType } from '@dcl/schemas'
import { createWorldsManagerComponent } from '../../src/adapters/worlds-manager'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { PartialUploadExpiredError } from '../../src/logic/partial-upload-admission'
import { IWorldsManager } from '../../src/types'

type Components = Parameters<typeof createWorldsManagerComponent>[0]

describe('when the worlds manager publishes the completion of a partial upload', () => {
  let recordPublication: jest.Mock
  let worldsManager: IWorldsManager
  let scene: Entity
  let caughtError: unknown

  beforeEach(async () => {
    recordPublication = jest.fn()
    scene = {
      version: 'v3',
      id: 'entity-id',
      type: EntityType.SCENE,
      timestamp: 1,
      pointers: ['0,0'],
      content: [],
      metadata: { scene: { parcels: ['0,0'], base: '0,0' } }
    }
    worldsManager = await createWorldsManagerComponent({
      settingsPolicy: {
        toStorableTitle: () => null,
        toStorableDescription: () => null,
        isValidContentRating: () => false,
        toStorableSkyboxTime: () => null,
        toStorableCategories: () => null
      },
      coordinates: createCoordinatesComponent(),
      logs: { getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
      database: {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        withAsyncContextTransaction: jest.fn((operation: () => Promise<unknown>) => operation())
      },
      nameDenyListChecker: {},
      pendingScenesRepository: { recordPublication },
      search: {},
      storage: {},
      thumbnails: {}
    } as unknown as Components)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  async function publish(): Promise<void> {
    caughtError = await worldsManager
      .deployScene(
        'world.dcl.eth',
        scene,
        '0xowner',
        { mode: 'unrestricted-owner' },
        {
          authChain: [{ type: AuthLinkType.SIGNER, payload: '0xDeployer', signature: '' }],
          size: 1,
          completesPartialUpload: { ttlMs: 3_600_000 }
        }
      )
      .then(() => undefined)
      .catch((error: unknown) => error)
  }

  describe('and the upload is consumed while live by the database clock', () => {
    beforeEach(async () => {
      recordPublication.mockResolvedValueOnce({ consumed: true, live: true })
      await publish()
    })

    it('should publish it', () => {
      expect(caughtError).toBeUndefined()
    })

    it('should record the publication with the upload lifetime', () => {
      expect(recordPublication.mock.calls[0][1]).toEqual(
        expect.objectContaining({ entityId: 'entity-id', completesPartialUpload: { ttlMs: 3_600_000 } })
      )
    })
  })

  describe('and the upload is consumed after it expired by the database clock', () => {
    beforeEach(async () => {
      recordPublication.mockResolvedValueOnce({ consumed: true, live: false })
      await publish()
    })

    it('should refuse to publish it', () => {
      expect(caughtError).toBeInstanceOf(PartialUploadExpiredError)
    })
  })

  describe('and the upload is already gone', () => {
    beforeEach(async () => {
      recordPublication.mockResolvedValueOnce({ consumed: false, live: false })
      await publish()
    })

    it('should refuse to publish it', () => {
      expect(caughtError).toBeInstanceOf(PartialUploadExpiredError)
    })
  })
})
