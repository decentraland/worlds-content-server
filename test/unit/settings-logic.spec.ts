import { IConfigComponent } from '@well-known-components/interfaces'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IContentStorageComponent, createInMemoryStorage } from '@dcl/catalyst-storage'
import { IPublisherComponent } from '@dcl/sns-component'
import { Events } from '@dcl/schemas'
import { createSettingsComponent, ISettingsComponent } from '../../src/logic/settings'
import { IPermissionsComponent } from '../../src/logic/permissions'
import {
  IWorldNamePermissionChecker,
  IWorldsManager,
  WorldSettings,
  SpawnCoordinatesOutOfBoundsError,
  NoDeployedScenesError
} from '../../src/types'
import { createMockedNamePermissionChecker } from '../mocks/dcl-name-checker-mock'
import { createMockedPermissionsComponent } from '../mocks/permissions-component-mock'
import { createMockedWorldsManager } from '../mocks/worlds-manager-mock'
import { createCoordinatesComponent, ICoordinatesComponent } from '../../src/logic/coordinates'
import { createSnsClientMock } from '../mocks/sns-client-mock'

describe('SettingsComponent', () => {
  let settingsComponent: ISettingsComponent
  let config: IConfigComponent
  let coordinates: ICoordinatesComponent
  let namePermissionChecker: jest.Mocked<IWorldNamePermissionChecker>
  let permissions: jest.Mocked<IPermissionsComponent>
  let storage: IContentStorageComponent
  let snsClient: IPublisherComponent
  let worldsManager: jest.Mocked<IWorldsManager>

  beforeEach(async () => {
    config = createConfigComponent({
      HTTP_BASE_URL: 'http://localhost:3000',
      AWS_SNS_ARN: 'test-arn'
    })
    coordinates = createCoordinatesComponent()
    namePermissionChecker = createMockedNamePermissionChecker()
    permissions = createMockedPermissionsComponent()
    storage = createInMemoryStorage()
    snsClient = createSnsClientMock()
    worldsManager = createMockedWorldsManager()

    settingsComponent = await createSettingsComponent({
      config,
      coordinates,
      namePermissionChecker,
      permissions,
      storage,
      snsClient,
      worldsManager
    })
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
      let updatedSettings: WorldSettings

      beforeEach(() => {
        updatedSettings = { spawnCoordinates: '10,20' }
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        // worldsManager.updateWorldSettings returns the new type with oldSpawnCoordinates
        worldsManager.updateWorldSettings.mockResolvedValue({
          settings: updatedSettings,
          oldSpawnCoordinates: '0,0'
        })
      })

      it('should update the world settings without checking the world-wide deployment permission', async () => {
        const result = await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(result).toEqual(updatedSettings)
        expect(namePermissionChecker.checkPermission).toHaveBeenCalledWith(signer.toLowerCase(), worldName)
        expect(permissions.hasWorldWidePermission).not.toHaveBeenCalled()
        expect(worldsManager.updateWorldSettings).toHaveBeenCalledWith(worldName, signer.toLowerCase(), {
          spawnCoordinates: '10,20'
        })
      })

      it('should emit SNS notifications for settings change and spawn coordinate change', async () => {
        await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(snsClient.publishMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              type: Events.Type.WORLD,
              subType: Events.SubType.Worlds.WORLD_SETTINGS_CHANGED,
              key: expect.stringContaining(worldName),
              metadata: expect.objectContaining({
                worldName
              })
            }),
            expect.objectContaining({
              type: Events.Type.WORLD,
              subType: Events.SubType.Worlds.WORLD_SPAWN_COORDINATE_SET,
              key: expect.stringContaining(worldName),
              metadata: expect.objectContaining({
                name: worldName,
                oldCoordinate: { x: 0, y: 0 },
                newCoordinate: { x: 10, y: 20 }
              })
            })
          ])
        )
      })
    })

    describe('when the signer owns the world name and spawn coordinates do not change', () => {
      let updatedSettings: WorldSettings

      beforeEach(() => {
        input = { title: 'Updated Title' }
        updatedSettings = { title: 'Updated Title', spawnCoordinates: '5,5' }
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        worldsManager.updateWorldSettings.mockResolvedValue({
          settings: updatedSettings,
          oldSpawnCoordinates: '5,5'
        })
      })

      it('should emit only the settings changed event without spawn coordinate event', async () => {
        await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(snsClient.publishMessages).toHaveBeenCalledWith([
          expect.objectContaining({
            type: Events.Type.WORLD,
            subType: Events.SubType.Worlds.WORLD_SETTINGS_CHANGED,
            key: expect.stringContaining(worldName),
            metadata: expect.objectContaining({
              worldName,
              title: 'Updated Title'
            })
          })
        ])
        // Verify only one event was sent (no spawn coordinate event)
        const calledWith = (snsClient.publishMessages as jest.Mock).mock.calls[0][0]
        expect(calledWith).toHaveLength(1)
      })
    })

    describe('when the world has no previous spawn coordinates', () => {
      let updatedSettings: WorldSettings

      beforeEach(() => {
        input = { spawnCoordinates: '10,20' }
        updatedSettings = { spawnCoordinates: '10,20' }
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        worldsManager.updateWorldSettings.mockResolvedValue({
          settings: updatedSettings,
          oldSpawnCoordinates: null
        })
      })

      it('should emit spawn coordinate event with null oldCoordinate', async () => {
        await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(snsClient.publishMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              type: Events.Type.WORLD,
              subType: Events.SubType.Worlds.WORLD_SPAWN_COORDINATE_SET,
              key: expect.stringContaining(worldName),
              metadata: expect.objectContaining({
                name: worldName,
                oldCoordinate: null,
                newCoordinate: { x: 10, y: 20 }
              })
            })
          ])
        )
      })
    })

    describe('when the signer does not own the world name and does not have world-wide deployment permission', () => {
      beforeEach(() => {
        signer = '0xUnauthorizedAddress'
        input = { spawnCoordinates: '5,10' }
        namePermissionChecker.checkPermission.mockResolvedValue(false)
        permissions.hasWorldWidePermission.mockResolvedValue(false)
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

    describe('when the signer does not own the world name but has world-wide deployment permission', () => {
      let updatedSettings: WorldSettings

      beforeEach(() => {
        signer = '0xWorldWideDeployer'
        input = { spawnCoordinates: '5,10' }
        updatedSettings = { spawnCoordinates: '5,10' }
        namePermissionChecker.checkPermission.mockResolvedValue(false)
        permissions.hasWorldWidePermission.mockResolvedValue(true)
        worldsManager.updateWorldSettings.mockResolvedValue({
          settings: updatedSettings,
          oldSpawnCoordinates: null
        })
      })

      it('should check the name ownership before checking the world-wide deployment permission and update the world settings', async () => {
        const result = await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(result).toEqual(updatedSettings)
        expect(namePermissionChecker.checkPermission).toHaveBeenCalledWith(signer.toLowerCase(), worldName)
        expect(permissions.hasWorldWidePermission).toHaveBeenCalledWith(worldName, 'deployment', signer.toLowerCase())
        const nameCheckOrder = namePermissionChecker.checkPermission.mock.invocationCallOrder[0]
        const worldWideCheckOrder = permissions.hasWorldWidePermission.mock.invocationCallOrder[0]
        expect(nameCheckOrder).toBeLessThan(worldWideCheckOrder)
      })
    })

    describe('when the spawnCoordinates are outside the world shape rectangle', () => {
      beforeEach(() => {
        input = { spawnCoordinates: '100,100' }
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        // worldsManager.updateWorldSettings throws SpawnCoordinatesOutOfBoundsError
        worldsManager.updateWorldSettings.mockRejectedValue(
          new SpawnCoordinatesOutOfBoundsError('100,100', {
            min: { x: 0, y: 0 },
            max: { x: 20, y: 30 }
          })
        )
      })

      it('should throw a ValidationError with a message saying that the spawn coordinates are outside the world shape rectangle', async () => {
        await expect(settingsComponent.updateWorldSettings(worldName, signer, input)).rejects.toThrow(
          expect.objectContaining({
            name: 'ValidationError',
            message:
              'Invalid spawnCoordinates "100,100". It must be within the world shape rectangle: (0,0) to (20,30).'
          })
        )
      })
    })

    describe('when the world has no deployed scenes', () => {
      beforeEach(() => {
        input = { spawnCoordinates: '10,20' }
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        // worldsManager.updateWorldSettings throws NoDeployedScenesError
        worldsManager.updateWorldSettings.mockRejectedValue(new NoDeployedScenesError(worldName))
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
      let updatedSettings: WorldSettings

      beforeEach(() => {
        input = {}
        updatedSettings = {}
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        worldsManager.updateWorldSettings.mockResolvedValue({
          settings: updatedSettings,
          oldSpawnCoordinates: '0,0'
        })
      })

      it('should update settings without validating spawnCoordinates', async () => {
        const result = await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(result).toEqual(updatedSettings)
        expect(worldsManager.updateWorldSettings).toHaveBeenCalledWith(worldName, signer.toLowerCase(), {})
      })
    })

    describe('when the signer address is mixed case', () => {
      let updatedSettings: WorldSettings

      beforeEach(() => {
        signer = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12'
        input = {}
        updatedSettings = {}
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        worldsManager.updateWorldSettings.mockResolvedValue({
          settings: updatedSettings,
          oldSpawnCoordinates: '0,0'
        })
      })

      it('should normalize the signer address to lowercase', async () => {
        await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(namePermissionChecker.checkPermission).toHaveBeenCalledWith(signer.toLowerCase(), worldName)
      })
    })

    describe('when the world does not exist yet', () => {
      let updatedSettings: WorldSettings

      beforeEach(() => {
        input = { title: 'My World' }
        updatedSettings = { title: 'My World' }
        namePermissionChecker.checkPermission.mockResolvedValue(true)
        worldsManager.updateWorldSettings.mockResolvedValue({
          settings: updatedSettings,
          oldSpawnCoordinates: null
        })
      })

      it('should create the world entry via upsert and update settings', async () => {
        const result = await settingsComponent.updateWorldSettings(worldName, signer, input)

        expect(worldsManager.updateWorldSettings).toHaveBeenCalledWith(worldName, signer.toLowerCase(), {
          title: 'My World'
        })
        expect(result).toEqual(updatedSettings)
      })
    })
  })
})
