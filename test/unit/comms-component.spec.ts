import { createCommsComponent } from '../../src/logic/comms/component'
import { ICommsComponent } from '../../src/logic/comms/types'
import { InvalidWorldError, InvalidAccessError, SceneNotFoundError, WorldAtCapacityError } from '../../src/logic/comms/errors'
import { ICommsAdapter, IWorldNamePermissionChecker } from '../../src/types'
import { IAccessComponent } from '../../src/logic/access/types'
import { IWorldsComponent } from '../../src/logic/worlds/types'

describe('CommsComponent', () => {
  let commsComponent: ICommsComponent
  let namePermissionChecker: jest.Mocked<IWorldNamePermissionChecker>
  let access: jest.Mocked<IAccessComponent>
  let worlds: jest.Mocked<IWorldsComponent>
  let commsAdapter: jest.Mocked<ICommsAdapter>

  beforeEach(() => {
    namePermissionChecker = {
      checkPermission: jest.fn()
    } as unknown as jest.Mocked<IWorldNamePermissionChecker>

    access = {
      checkAccess: jest.fn()
    } as unknown as jest.Mocked<IAccessComponent>

    worlds = {
      isWorldValid: jest.fn(),
      isWorldBlocked: jest.fn(),
      hasWorldScene: jest.fn()
    } as unknown as jest.Mocked<IWorldsComponent>

    commsAdapter = {
      getWorldRoomConnectionString: jest.fn(),
      getSceneRoomConnectionString: jest.fn(),
      getRoomParticipantCount: jest.fn(),
      status: jest.fn()
    } as unknown as jest.Mocked<ICommsAdapter>

    commsComponent = createCommsComponent({
      namePermissionChecker,
      access,
      worlds,
      commsAdapter
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when getting world room connection string', () => {
    const userAddress = '0x1234'
    const worldName = 'test-world'
    const connectionString = 'livekit:wss://host?access_token=abc123'

    describe('and the world is valid', () => {
      beforeEach(() => {
        worlds.isWorldValid.mockResolvedValueOnce(true)
      })

      describe('and the user has permission and access', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(true)
          access.checkAccess.mockResolvedValueOnce(true)
          commsAdapter.getRoomParticipantCount.mockResolvedValueOnce(0)
          commsAdapter.getWorldRoomConnectionString.mockResolvedValueOnce(connectionString)
        })

        it('should return the connection string', async () => {
          const result = await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
          expect(result).toBe(connectionString)
        })

        it('should check world validity', async () => {
          await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
          expect(worlds.isWorldValid).toHaveBeenCalledWith(worldName)
        })

        it('should check name permission', async () => {
          await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
          expect(namePermissionChecker.checkPermission).toHaveBeenCalledWith(userAddress, worldName)
        })

        it('should check access without secret', async () => {
          await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
          expect(access.checkAccess).toHaveBeenCalledWith(worldName, userAddress, undefined)
        })

        it('should call the adapter with correct parameters', async () => {
          await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
          expect(commsAdapter.getRoomParticipantCount).toHaveBeenCalledWith(worldName)
          expect(commsAdapter.getWorldRoomConnectionString).toHaveBeenCalledWith(userAddress, worldName)
        })
      })

      describe('and the user has permission and access with secret', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(true)
          access.checkAccess.mockResolvedValueOnce(true)
          commsAdapter.getRoomParticipantCount.mockResolvedValueOnce(0)
          commsAdapter.getWorldRoomConnectionString.mockResolvedValueOnce(connectionString)
        })

        it('should check access with the provided secret', async () => {
          await commsComponent.getWorldRoomConnectionString(userAddress, worldName, { secret: 'my-secret' })
          expect(access.checkAccess).toHaveBeenCalledWith(worldName, userAddress, 'my-secret')
        })
      })

      describe('and the user does not have permission', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(false)
          access.checkAccess.mockResolvedValueOnce(true)
        })

        it('should throw InvalidAccessError', async () => {
          await expect(commsComponent.getWorldRoomConnectionString(userAddress, worldName)).rejects.toThrow(
            InvalidAccessError
          )
        })

        it('should not call the adapter', async () => {
          try {
            await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
          } catch {
            // Expected to throw
          }
          expect(commsAdapter.getRoomParticipantCount).not.toHaveBeenCalled()
          expect(commsAdapter.getWorldRoomConnectionString).not.toHaveBeenCalled()
        })
      })

      describe('and the world is at capacity', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(true)
          access.checkAccess.mockResolvedValueOnce(true)
          commsAdapter.getRoomParticipantCount.mockResolvedValueOnce(100)
        })

        it('should throw WorldAtCapacityError', async () => {
          await expect(commsComponent.getWorldRoomConnectionString(userAddress, worldName)).rejects.toThrow(
            WorldAtCapacityError
          )
        })

        it('should not call getWorldRoomConnectionString', async () => {
          try {
            await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
          } catch {
            // Expected to throw
          }
          expect(commsAdapter.getWorldRoomConnectionString).not.toHaveBeenCalled()
        })
      })

      describe('and the user does not have access', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(true)
          access.checkAccess.mockResolvedValueOnce(false)
        })

        it('should throw InvalidAccessError', async () => {
          await expect(commsComponent.getWorldRoomConnectionString(userAddress, worldName)).rejects.toThrow(
            InvalidAccessError
          )
        })
      })

      describe('and the user has neither permission nor access', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(false)
          access.checkAccess.mockResolvedValueOnce(false)
        })

        it('should throw InvalidAccessError', async () => {
          await expect(commsComponent.getWorldRoomConnectionString(userAddress, worldName)).rejects.toThrow(
            InvalidAccessError
          )
        })
      })
    })

    describe('and the world is not valid', () => {
      beforeEach(() => {
        worlds.isWorldValid.mockResolvedValueOnce(false)
      })

      it('should throw InvalidWorldError', async () => {
        await expect(commsComponent.getWorldRoomConnectionString(userAddress, worldName)).rejects.toThrow(
          InvalidWorldError
        )
      })

      it('should not check permissions', async () => {
        try {
          await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
        } catch {
          // Expected to throw
        }
        expect(namePermissionChecker.checkPermission).not.toHaveBeenCalled()
        expect(access.checkAccess).not.toHaveBeenCalled()
      })

      it('should not call the adapter', async () => {
        try {
          await commsComponent.getWorldRoomConnectionString(userAddress, worldName)
        } catch {
          // Expected to throw
        }
        expect(commsAdapter.getWorldRoomConnectionString).not.toHaveBeenCalled()
      })
    })
  })

  describe('when getting scene room connection string', () => {
    const userAddress = '0x1234'
    const worldName = 'test-world'
    const sceneId = 'scene-123'
    const connectionString = 'livekit:wss://host?access_token=abc123'

    describe('and the world is valid', () => {
      beforeEach(() => {
        worlds.isWorldValid.mockResolvedValueOnce(true)
      })

      describe('and the user has permission and access', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(true)
          access.checkAccess.mockResolvedValueOnce(true)
        })

        describe('and the scene exists', () => {
          beforeEach(() => {
            worlds.hasWorldScene.mockResolvedValueOnce(true)
            commsAdapter.getSceneRoomConnectionString.mockResolvedValueOnce(connectionString)
          })

          it('should return the connection string', async () => {
            const result = await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
            expect(result).toBe(connectionString)
          })

          it('should check if the scene exists', async () => {
            await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
            expect(worlds.hasWorldScene).toHaveBeenCalledWith(worldName, sceneId)
          })

          it('should call the adapter with correct parameters', async () => {
            await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
            expect(commsAdapter.getSceneRoomConnectionString).toHaveBeenCalledWith(userAddress, worldName, sceneId)
          })
        })

        describe('and the scene does not exist', () => {
          beforeEach(() => {
            worlds.hasWorldScene.mockResolvedValueOnce(false)
          })

          it('should throw SceneNotFoundError', async () => {
            await expect(
              commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
            ).rejects.toThrow(SceneNotFoundError)
          })

          it('should not call the adapter', async () => {
            try {
              await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
            } catch {
              // Expected to throw
            }
            expect(commsAdapter.getSceneRoomConnectionString).not.toHaveBeenCalled()
          })
        })
      })

      describe('and the user has permission and access with secret', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(true)
          access.checkAccess.mockResolvedValueOnce(true)
          worlds.hasWorldScene.mockResolvedValueOnce(true)
          commsAdapter.getSceneRoomConnectionString.mockResolvedValueOnce(connectionString)
        })

        it('should check access with the provided secret', async () => {
          await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId, {
            secret: 'my-secret'
          })
          expect(access.checkAccess).toHaveBeenCalledWith(worldName, userAddress, 'my-secret')
        })
      })

      describe('and the user does not have permission', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(false)
          access.checkAccess.mockResolvedValueOnce(true)
        })

        it('should throw InvalidAccessError', async () => {
          await expect(
            commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
          ).rejects.toThrow(InvalidAccessError)
        })

        it('should not check if scene exists', async () => {
          try {
            await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
          } catch {
            // Expected to throw
          }
          expect(worlds.hasWorldScene).not.toHaveBeenCalled()
        })
      })

      describe('and the user does not have access', () => {
        beforeEach(() => {
          namePermissionChecker.checkPermission.mockResolvedValueOnce(true)
          access.checkAccess.mockResolvedValueOnce(false)
        })

        it('should throw InvalidAccessError', async () => {
          await expect(
            commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
          ).rejects.toThrow(InvalidAccessError)
        })
      })
    })

    describe('and the world is not valid', () => {
      beforeEach(() => {
        worlds.isWorldValid.mockResolvedValueOnce(false)
      })

      it('should throw InvalidWorldError', async () => {
        await expect(commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)).rejects.toThrow(
          InvalidWorldError
        )
      })

      it('should not check permissions', async () => {
        try {
          await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
        } catch {
          // Expected to throw
        }
        expect(namePermissionChecker.checkPermission).not.toHaveBeenCalled()
        expect(access.checkAccess).not.toHaveBeenCalled()
      })

      it('should not check if scene exists', async () => {
        try {
          await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
        } catch {
          // Expected to throw
        }
        expect(worlds.hasWorldScene).not.toHaveBeenCalled()
      })

      it('should not call the adapter', async () => {
        try {
          await commsComponent.getWorldSceneRoomConnectionString(userAddress, worldName, sceneId)
        } catch {
          // Expected to throw
        }
        expect(commsAdapter.getSceneRoomConnectionString).not.toHaveBeenCalled()
      })
    })
  })
})
