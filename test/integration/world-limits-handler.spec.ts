import { test } from '../components'
import { WorldOwnerNotFoundError } from '../../src/adapters/limits-manager'

test('world limits handler GET /world/:world_name/limits', function ({ components }) {
  let response: Response
  let body: unknown

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('when requesting the limits of a world with mixed casing and parcels', () => {
    let sizeSpy: jest.SpyInstance

    beforeEach(async () => {
      sizeSpy = jest.spyOn(components.limitsManager, 'getMaxAllowedSizeInBytesFor').mockResolvedValueOnce(123456789n)
      response = await components.localFetch.fetch('/world/Privileged.DCL.eth/limits?parcels=0,0&parcels=0,1')
      body = await response.json()
    })

    it('should respond with the limits of the lowercased world', () => {
      expect({ status: response.status, body }).toEqual({
        status: 200,
        body: { maxSceneSizeInBytes: '123456789', maxParcels: 50 }
      })
    })

    it('should compute the size limit for the requested parcels', () => {
      expect(sizeSpy).toHaveBeenCalledWith('privileged.dcl.eth', ['0,0', '0,1'])
    })
  })

  describe('when requesting the limits with an invalid parcel', () => {
    beforeEach(async () => {
      response = await components.localFetch.fetch('/world/privileged.dcl.eth/limits?parcels=a,b')
      body = await response.json()
    })

    it('should respond with a 400 and the repo error body', () => {
      expect({ status: response.status, body }).toEqual({
        status: 400,
        body: {
          error: 'Bad request',
          message: 'Invalid coordinate values: a,b'
        }
      })
    })
  })

  describe('when the world name is deny-listed', () => {
    let sizeSpy: jest.SpyInstance

    beforeEach(async () => {
      jest.spyOn(components.nameDenyListChecker, 'checkNameDenyList').mockResolvedValueOnce(false)
      sizeSpy = jest.spyOn(components.limitsManager, 'getMaxAllowedSizeInBytesFor')
      response = await components.localFetch.fetch('/world/Banned.dcl.eth/limits')
      body = await response.json()
    })

    it('should respond with a 404 and the repo error body', () => {
      expect({ status: response.status, body }).toEqual({
        status: 404,
        body: { error: 'Not Found', message: 'World "banned.dcl.eth" not found.' }
      })
    })

    it('should not compute the size limit', () => {
      expect(sizeSpy).not.toHaveBeenCalled()
    })
  })

  describe('when the owner of the world name cannot be determined', () => {
    beforeEach(async () => {
      jest
        .spyOn(components.limitsManager, 'getMaxAllowedSizeInBytesFor')
        .mockRejectedValueOnce(new WorldOwnerNotFoundError('unowned.dcl.eth'))
      response = await components.localFetch.fetch('/world/unowned.dcl.eth/limits')
      body = await response.json()
    })

    it('should respond with a 404 and the repo error body', () => {
      expect({ status: response.status, body }).toEqual({
        status: 404,
        body: { error: 'Not Found', message: 'Could not determine owner for world unowned.dcl.eth' }
      })
    })
  })
})
