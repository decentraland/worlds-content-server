import { createHash } from 'crypto'
import { AppComponents, WorldSettings, WorldSettingsInput } from '../../types'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from './errors'
import { ISettingsComponent } from './types'
import { bufferToStream } from '@dcl/catalyst-storage/dist/content-item'

export async function createSettingsComponent(
  components: Pick<
    AppComponents,
    'config' | 'coordinates' | 'namePermissionChecker' | 'storage' | 'snsClient' | 'worldsManager'
  >
): Promise<ISettingsComponent> {
  const { config, coordinates, namePermissionChecker, storage, snsClient, worldsManager } = components
  const baseUrl = await config.requireString('HTTP_BASE_URL')

  const { parseCoordinate, isCoordinateWithinRectangle } = coordinates

  async function getWorldSettings(worldName: string): Promise<WorldSettings> {
    const settings = await worldsManager.getWorldSettings(worldName)

    if (!settings) {
      throw new WorldNotFoundError(worldName)
    }

    return settings
  }

  async function updateWorldSettings(
    worldName: string,
    signer: string,
    settings: WorldSettingsInput
  ): Promise<WorldSettings> {
    const normalizedSigner = signer.toLowerCase()

    // Only name owners can update world settings
    const hasNamePermission = await namePermissionChecker.checkPermission(normalizedSigner, worldName)

    if (!hasNamePermission) {
      throw new UnauthorizedError()
    }

    // Validate spawnCoordinates if provided
    if (settings.spawnCoordinates) {
      const boundingRectangle = await worldsManager.getWorldBoundingRectangle(worldName)

      if (!boundingRectangle) {
        throw new ValidationError(
          `Invalid spawnCoordinates "${settings.spawnCoordinates}". The world has no deployed scenes.`
        )
      }

      let spawnCoord: ReturnType<typeof parseCoordinate>

      try {
        spawnCoord = parseCoordinate(settings.spawnCoordinates)
      } catch (error) {
        throw new ValidationError(`Invalid spawnCoordinates format: "${settings.spawnCoordinates}".`)
      }
      const isWithinBounds = isCoordinateWithinRectangle(spawnCoord, boundingRectangle)

      if (!isWithinBounds) {
        const { min, max } = boundingRectangle
        throw new ValidationError(
          `Invalid spawnCoordinates "${settings.spawnCoordinates}". It must be within the world shape rectangle: (${min.x},${min.y}) to (${max.x},${max.y}).`
        )
      }
    }

    // Handle thumbnail upload
    let thumbnailHash: string | undefined
    if (settings.thumbnail) {
      // Store new thumbnail by hash (content-addressable, old thumbnails cleaned up by GC)
      thumbnailHash = createHash('sha256').update(settings.thumbnail).digest('hex')
      await storage.storeStream(thumbnailHash, bufferToStream(settings.thumbnail))
    }

    const updatedSettings = await worldsManager.updateWorldSettings(worldName, normalizedSigner, {
      ...settings,
      thumbnailHash: thumbnailHash ?? undefined
    })

    // Emit SNS notification for settings change
    await emitSettingsChangedEvent(worldName, updatedSettings)

    return updatedSettings
  }

  function getThumbnailUrl(hash: string): string {
    return `${baseUrl}/contents/${hash}`
  }

  async function emitSettingsChangedEvent(worldName: string, settings: WorldSettings): Promise<void> {
    const settingsChangedEvent = {
      type: 'worlds' as const,
      subType: 'worlds-settings-changed' as const,
      key: worldName,
      timestamp: Date.now(),
      worldName,
      settings: {
        title: settings.title,
        description: settings.description,
        contentRating: settings.contentRating,
        spawnCoordinates: settings.spawnCoordinates,
        skyboxTime: settings.skyboxTime,
        categories: settings.categories,
        singlePlayer: settings.singlePlayer,
        showInPlaces: settings.showInPlaces,
        thumbnailUrl: settings.thumbnailHash ? getThumbnailUrl(settings.thumbnailHash) : undefined
      },
      contentServerUrls: baseUrl ? [baseUrl] : []
    }

    await snsClient.publishMessage(settingsChangedEvent)
  }

  return {
    getWorldSettings,
    updateWorldSettings
  }
}
