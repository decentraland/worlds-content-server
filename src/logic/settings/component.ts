import { AppComponents, WorldSettings } from '../../types'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from './errors'
import { ISettingsComponent } from './types'

export function createSettingsComponent(
  components: Pick<AppComponents, 'coordinates' | 'namePermissionChecker' | 'worldsManager'>
): ISettingsComponent {
  const { coordinates, namePermissionChecker, worldsManager } = components
  const { parseCoordinate, isCoordinateWithinRectangle } = coordinates

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

    // Validate spawnCoordinates is within the world's bounding rectangle
    if (input.spawnCoordinates) {
      const boundingRectangle = await worldsManager.getWorldBoundingRectangle(worldName)

      if (!boundingRectangle) {
        throw new ValidationError(
          `Invalid spawnCoordinates "${input.spawnCoordinates}". The world has no deployed scenes.`
        )
      }

      let spawnCoord: ReturnType<typeof parseCoordinate>

      try {
        spawnCoord = parseCoordinate(input.spawnCoordinates)
      } catch (error) {
        throw new ValidationError(`Invalid spawnCoordinates format: "${input.spawnCoordinates}".`)
      }
      const isWithinBounds = isCoordinateWithinRectangle(spawnCoord, boundingRectangle)

      if (!isWithinBounds) {
        const { min, max } = boundingRectangle
        throw new ValidationError(
          `Invalid spawnCoordinates "${input.spawnCoordinates}". It must be within the world shape rectangle: (${min.x},${min.y}) to (${max.x},${max.y}).`
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
