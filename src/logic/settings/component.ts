import { AppComponents, WorldSettings } from '../../types'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from './errors'
import { ISettingsComponent } from './types'

export function createSettingsComponent(
  components: Pick<AppComponents, 'namePermissionChecker' | 'worldsManager'>
): ISettingsComponent {
  const { namePermissionChecker, worldsManager } = components

  async function getWorldSettings(worldName: string): Promise<WorldSettings> {
    const settings = await worldsManager.getWorldSettings(worldName)

    if (!settings) {
      throw new WorldNotFoundError(worldName)
    }

    return settings
  }

  async function updateWorldSettings(worldName: string, signer: string, input: WorldSettings): Promise<WorldSettings> {
    const normalizedSigner = signer.toLowerCase()

    // Only name owners can update world settings
    const hasNamePermission = await namePermissionChecker.checkPermission(normalizedSigner, worldName)

    if (!hasNamePermission) {
      throw new UnauthorizedError()
    }

    // Validate spawnCoordinates belongs to a deployed scene
    if (input.spawnCoordinates) {
      const { scenes } = await worldsManager.getWorldScenes(
        { worldName, coordinates: [input.spawnCoordinates] },
        { limit: 1 }
      )

      if (scenes.length === 0) {
        throw new ValidationError(
          `Invalid spawnCoordinates "${input.spawnCoordinates}". It must belong to a parcel of a deployed scene.`
        )
      }
    }

    const settings: WorldSettings = {
      spawnCoordinates: input.spawnCoordinates
    }

    await worldsManager.updateWorldSettings(worldName, settings)

    return settings
  }

  return {
    getWorldSettings,
    updateWorldSettings
  }
}
