import { InvalidRequestError, NotFoundError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@dcl/core-commons'
import { getWorldLimitsHandler } from '../../src/controllers/handlers/world-limits-handler'
import { WorldOwnerNotFoundError } from '../../src/adapters/limits-manager'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { ILimitsManager, INameDenyListChecker, MB_BigInt } from '../../src/types'

type HandlerContext = Parameters<typeof getWorldLimitsHandler>[0]

describe('when getting the limits of a world', () => {
  let limitsManager: jest.Mocked<ILimitsManager>
  let nameDenyListChecker: jest.Mocked<INameDenyListChecker>
  let query: string
  let worldName: string
  let response: IHttpServerComponent.IResponse | undefined
  let error: unknown

  async function run(): Promise<void> {
    const context: HandlerContext = {
      components: { coordinates: createCoordinatesComponent(), limitsManager, nameDenyListChecker },
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
    nameDenyListChecker = {
      checkNameDenyList: jest.fn().mockResolvedValue(true),
      getBannedNames: jest.fn()
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

  describe('and parcels are requested as unique canonical coordinates', () => {
    beforeEach(async () => {
      query = '?parcels=0,0&parcels=0,1&parcels=-1,0'
      await run()
    })

    it('should compute the size limit for the requested parcels', () => {
      expect(limitsManager.getMaxAllowedSizeInBytesFor).toHaveBeenCalledWith('my-world.dcl.eth', ['0,0', '0,1', '-1,0'])
    })

    it('should respond with the limits', () => {
      expect(response?.status).toBe(200)
    })
  })

  describe.each([
    ['a parcel is repeated', '?parcels=0,0&parcels=0,1&parcels=0,0'],
    ['a parcel has a signed zero', '?parcels=-0,1'],
    ['a parcel has a leading zero', '?parcels=01,0'],
    ['a parcel has whitespace', '?parcels=%200,0'],
    ['a parcel has more than two values', '?parcels=0,0,1'],
    ['a parcel has trailing non-digit characters', '?parcels=1abc,2'],
    ['a parcel has a non-integer coordinate', '?parcels=1.5,0'],
    ['the parcels parameter is empty', '?parcels=']
  ])('and %s', (_case, requestedQuery) => {
    beforeEach(async () => {
      query = requestedQuery
      await run()
    })

    it('should reject the request as a deployment would reject the pointers', () => {
      expect(error).toEqual(
        new InvalidRequestError('Parcels must be unique canonical "x,y" coordinates, as in a scene\'s parcels.')
      )
    })

    it('should not compute any limit', () => {
      expect(limitsManager.getMaxAllowedSizeInBytesFor).not.toHaveBeenCalled()
    })
  })

  describe('and more than five hundred unique parcels are requested', () => {
    let parcels: string[]

    beforeEach(async () => {
      parcels = Array.from({ length: 502 }, (_, i) => `${(i % 301) - 150},${Math.floor(i / 301)}`)
      query = `?${parcels.map((parcel) => `parcels=${parcel}`).join('&')}`
      await run()
    })

    it('should compute the size limit for every requested parcel', () => {
      expect(limitsManager.getMaxAllowedSizeInBytesFor).toHaveBeenCalledWith('my-world.dcl.eth', parcels)
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

  describe('and the world name is deny-listed', () => {
    beforeEach(async () => {
      nameDenyListChecker.checkNameDenyList.mockResolvedValueOnce(false)
      await run()
    })

    it('should check the lowercased world name against the deny list', () => {
      expect(nameDenyListChecker.checkNameDenyList).toHaveBeenCalledWith('my-world.dcl.eth')
    })

    it('should fail with a not found error', () => {
      expect(error).toEqual(new NotFoundError('World "my-world.dcl.eth" not found.'))
    })

    it('should not compute any limit', () => {
      expect(limitsManager.getMaxAllowedSizeInBytesFor).not.toHaveBeenCalled()
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
