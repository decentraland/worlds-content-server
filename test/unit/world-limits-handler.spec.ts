import { InvalidRequestError, NotFoundError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@dcl/core-commons'
import { getWorldLimitsHandler } from '../../src/controllers/handlers/world-limits-handler'
import { WorldOwnerNotFoundError } from '../../src/adapters/limits-manager'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { ILimitsManager, MB_BigInt } from '../../src/types'

type HandlerContext = Parameters<typeof getWorldLimitsHandler>[0]

describe('when getting the limits of a world', () => {
  let limitsManager: jest.Mocked<ILimitsManager>
  let query: string
  let worldName: string
  let response: IHttpServerComponent.IResponse | undefined
  let error: unknown

  async function run(): Promise<void> {
    const context: HandlerContext = {
      components: { coordinates: createCoordinatesComponent(), limitsManager },
      params: { world_name: worldName },
      url: new URL(`http://localhost/world/${worldName}/limits${query}`)
    }
    response = undefined
    error = undefined
    try {
      response = await getWorldLimitsHandler(context)
    } catch (e) {
      error = e
    }
  }

  beforeEach(() => {
    worldName = 'My-World.dcl.eth'
    query = ''
    limitsManager = {
      getAllowSdk6For: jest.fn(),
      getMaxAllowedParcelsFor: jest.fn().mockResolvedValue(4),
      getMaxAllowedSizeInBytesFor: jest.fn().mockResolvedValue(120n * MB_BigInt),
      getSceneSizeCapInBytesFor: jest.fn()
    }
  })

  describe('and no parcels are requested', () => {
    beforeEach(async () => {
      await run()
    })

    it('should respond with the size limit as a decimal string and the parcel limit', () => {
      expect(response).toEqual({
        status: 200,
        body: { maxSceneSizeInBytes: (120n * MB_BigInt).toString(), maxParcels: 4 }
      })
    })

    it('should compute the size limit for the lowercased world without parcels', () => {
      expect(limitsManager.getMaxAllowedSizeInBytesFor).toHaveBeenCalledWith('my-world.dcl.eth', undefined)
    })

    it('should compute the parcel limit for the lowercased world', () => {
      expect(limitsManager.getMaxAllowedParcelsFor).toHaveBeenCalledWith('my-world.dcl.eth')
    })
  })

  describe('and parcels are requested with repeated, duplicated and non-canonical values', () => {
    beforeEach(async () => {
      query = '?parcels=00,00&parcels=0,0&parcels=-0,1'
      await run()
    })

    it('should compute the size limit for the canonical, deduplicated parcels', () => {
      expect(limitsManager.getMaxAllowedSizeInBytesFor).toHaveBeenCalledWith('my-world.dcl.eth', ['0,0', '0,1'])
    })

    it('should respond with the limits', () => {
      expect(response?.status).toBe(200)
    })
  })

  describe('and a requested parcel is not an "x,y" coordinate', () => {
    beforeEach(async () => {
      query = '?parcels=0,0&parcels=0,0,1'
      await run()
    })

    it('should reject the request as invalid', () => {
      expect(error).toBeInstanceOf(InvalidRequestError)
    })

    it('should not compute any limit', () => {
      expect(limitsManager.getMaxAllowedSizeInBytesFor).not.toHaveBeenCalled()
    })
  })

  describe('and a requested parcel has a non-integer coordinate', () => {
    beforeEach(async () => {
      query = '?parcels=1.5,0'
      await run()
    })

    it('should reject the request with the parcel format error', () => {
      expect(error).toEqual(
        new InvalidRequestError('Invalid parcel format: "1.5,0". Expected "x,y" format (e.g., "0,0" or "-5,10").')
      )
    })
  })

  describe('and the parcels parameter is empty', () => {
    beforeEach(async () => {
      query = '?parcels='
      await run()
    })

    it('should reject the request as invalid', () => {
      expect(error).toBeInstanceOf(InvalidRequestError)
    })
  })

  describe('and a requested parcel is out of bounds', () => {
    beforeEach(async () => {
      query = '?parcels=151,0'
      await run()
    })

    it('should reject the request with the bounds error', () => {
      expect(error).toEqual(
        new InvalidRequestError('Coordinate X value 151 is out of bounds. Must be between -150 and 150.')
      )
    })
  })

  describe('and the owner of the world name cannot be determined', () => {
    beforeEach(async () => {
      limitsManager.getMaxAllowedSizeInBytesFor.mockRejectedValueOnce(new WorldOwnerNotFoundError('my-world.dcl.eth'))
      await run()
    })

    it('should fail with a not found error carrying the owner message', () => {
      expect(error).toEqual(new NotFoundError('Could not determine owner for world my-world.dcl.eth'))
    })

    it('should fail with an error the error handler maps to a 404', () => {
      expect(error).toBeInstanceOf(NotFoundError)
    })
  })

  describe('and computing the limits fails unexpectedly', () => {
    let failure: Error

    beforeEach(async () => {
      failure = new Error('subgraph unavailable')
      limitsManager.getMaxAllowedSizeInBytesFor.mockRejectedValueOnce(failure)
      await run()
    })

    it('should propagate the error', () => {
      expect(error).toBe(failure)
    })
  })
})
