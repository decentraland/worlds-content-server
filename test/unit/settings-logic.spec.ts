import { createSettingsComponent, ISettingsComponent } from '../../src/logic/settings'
import { IWorldNamePermissionChecker, IWorldsManager, WorldSettings } from '../../src/types'
import { createMockedNamePermissionChecker } from '../mocks/dcl-name-checker-mock'
import { createMockedWorldsManager } from '../mocks/world-manager-mock'
import { createCoordinatesComponent, ICoordinatesComponent } from '../../src/logic/coordinates'

describe('SettingsComponent', () => {
  let settingsComponent: ISettingsComponent
  let coordinates: ICoordinatesComponent
  let namePermissionChecker: jest.Mocked<IWorldNamePermissionChecker>
  let worldsManager: jest.Mocked<IWorldsManager>

  beforeEach(() => {
    coordinates = createCoordinatesComponent()
    namePermissionChecker = createMockedNamePermissionChecker()
    worldsManager = createMockedWorldsManager()

    settingsComponent = createSettingsComponent({ coordinates, namePermissionChecker, worldsManager })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when getting the world settings', () => {
    let worldName: string

    beforeEach(() => {
      worldName = 'test-world.dcl.eth'
    })

    describe('when the world exists and has settings', () => {
      let expectedSettings: WorldSettings

      beforeEach(() => {
        expectedSettings = { spawnCoordinates: '10,20' }
        worldsManager.getWorldSettings.mockResolvedValue(expectedSettings)
      })

      it('should return the world settings', async () => {
        const result = await settingsComponent.getWorldSettings(worldName)

        expect(result).toEqual(expectedSettings)
        expect(worldsManager.getWorldSettings).toHaveBeenCalledWith(worldName)
      })
    })

    describe('when the world does not exist', () => {
      beforeEach(() => {
        worldName = 'non-existent-world.dcl.eth'
        worldsManager.getWorldSettings.mockResolvedValue(undefined)
      })

      it('should throw a WorldNotFoundError with the correct message', async () => {
        await expect(settingsComponent.getWorldSettings(worldName)).rejects.toThrow(
          expect.objectContaining({
            name: 'WorldNotFoundError',
            message: `World "${worldName}" not found or has no settings configured.`
          })
        )
      })
    })
  })

  describe('when updating the world settings', () => {
    let worldName: string
    let signer: string
    let input: WorldSettings

    beforeEach(() => {
      worldName = 'test-world.dcl.eth'
      signer = '0xOwnerAddress'
      input = { spawnCoordinates: '10,20' }
    })

    describe('when the signer owns the world name', () => {
      beforeEach(() => {
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        // Bounding rectangle from (0,0) to (20,30) - input coordinates (10,20) are within this range
        worldsManager.getWorldBoundingRectangle.mockResolvedValue({
          min: { x: 0, y: 0 },
          max: { x: 20, y: 30 }
        })
        worldsManager.updateWorldSettings.mockResolvedValue(undefined)
      })

      it('should update the world settings', async () => {
        const result = await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(result).toEqual({ spawnCoordinates: '10,20' })
        expect(namePermissionChecker.checkPermission).toHaveBeenCalledWith(signer.toLowerCase(), worldName)
        expect(worldsManager.updateWorldSettings).toHaveBeenCalledWith(worldName, { spawnCoordinates: '10,20' })
      })
    })

    describe('when the signer does not own the world name', () => {
      beforeEach(() => {
        signer = '0xUnauthorizedAddress'
        input = { spawnCoordinates: '5,10' }
        namePermissionChecker.checkPermission.mockResolvedValue(false)
      })

      it('should throw an UnauthorizedError with the correct message', async () => {
        await expect(settingsComponent.updateWorldSettings(worldName, signer, input)).rejects.toThrow(
          expect.objectContaining({
            name: 'UnauthorizedError',
            message: 'Unauthorized. You do not have permission to update settings for this world.'
          })
        )
      })
    })

    describe('when the spawnCoordinates are outside the world shape rectangle', () => {
      beforeEach(() => {
        input = { spawnCoordinates: '999,999' }
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        // Bounding rectangle from (0,0) to (20,30) - input coordinates (999,999) are outside this range
        worldsManager.getWorldBoundingRectangle.mockResolvedValue({
          min: { x: 0, y: 0 },
          max: { x: 20, y: 30 }
        })
      })

      it('should throw a ValidationError with a message saying that the spawn coordinates are outside the world shape rectangle', async () => {
        await expect(settingsComponent.updateWorldSettings(worldName, signer, input)).rejects.toThrow(
          expect.objectContaining({
            name: 'ValidationError',
            message:
              'Invalid spawnCoordinates "999,999". It must be within the world shape rectangle: (0,0) to (20,30).'
          })
        )
      })
    })

    describe('when the world has no deployed scenes', () => {
      beforeEach(() => {
        input = { spawnCoordinates: '10,20' }
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        worldsManager.getWorldBoundingRectangle.mockResolvedValue(undefined)
      })

      it('should throw a ValidationError with the correct message', async () => {
        await expect(settingsComponent.updateWorldSettings(worldName, signer, input)).rejects.toThrow(
          expect.objectContaining({
            name: 'ValidationError',
            message: 'Invalid spawnCoordinates "10,20". The world has no deployed scenes.'
          })
        )
      })
    })

    describe('when the input does not include spawnCoordinates', () => {
      beforeEach(() => {
        input = {}
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        worldsManager.updateWorldSettings.mockResolvedValue(undefined)
      })

      it('should update settings without validating spawnCoordinates', async () => {
        const result = await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(result).toEqual({ spawnCoordinates: undefined })
        expect(worldsManager.updateWorldSettings).toHaveBeenCalledWith(worldName, { spawnCoordinates: undefined })
      })
    })

    describe('when the signer address is mixed case', () => {
      beforeEach(() => {
        signer = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12'
        input = {}
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        worldsManager.updateWorldSettings.mockResolvedValue(undefined)
      })

      it('should normalize the signer address to lowercase', async () => {
        await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(namePermissionChecker.checkPermission).toHaveBeenCalledWith(signer.toLowerCase(), worldName)
      })
    })
  })
})
