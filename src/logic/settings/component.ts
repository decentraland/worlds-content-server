import { createHash } from 'crypto'
import { Events, WorldSettingsChangedEvent, WorldSpawnCoordinateSetEvent } from '@dcl/schemas'
import {
  AppComponents,
  NoDeployedScenesError,
  SpawnCoordinatesOutOfBoundsError,
  WorldSettings,
  WorldSettingsInput
} from '../../types'
import { UnauthorizedError, ValidationError, WorldNotFoundError } from './errors'
import { ISettingsComponent } from './types'
import { bufferToStream } from '@dcl/catalyst-storage/dist/content-item'
import { Coordinate } from '../coordinates'

export async function createSettingsComponent(
  components: Pick<
    AppComponents,
    'config' | 'coordinates' | 'namePermissionChecker' | 'storage' | 'snsClient' | 'worldsManager'
  >
): Promise<ISettingsComponent> {
  const { config, coordinates, namePermissionChecker, storage, snsClient, worldsManager } = components
  const baseUrl = await config.requireString('HTTP_BASE_URL')

  const { parseCoordinate, areCoordinatesEqual } = coordinates

  function parseSpawnCoordinates(spawnCoordinates: string | null | undefined): Coordinate | null {
    if (!spawnCoordinates) {
      return null
    }
    return parseCoordinate(spawnCoordinates)
  }

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

    // Handle thumbnail upload
    let thumbnailHash: string | undefined
    if (settings.thumbnail) {
      // Store new thumbnail by hash (content-addressable, old thumbnails cleaned up by GC)
      thumbnailHash = createHash('sha256').update(settings.thumbnail).digest('hex')
      await storage.storeStream(thumbnailHash, bufferToStream(settings.thumbnail))
    }

    let result: { settings: WorldSettings; oldSpawnCoordinates: string | null }

    try {
      result = await worldsManager.updateWorldSettings(worldName, normalizedSigner, {
        ...settings,
        thumbnailHash: thumbnailHash ?? undefined
      })
    } catch (error) {
      // Convert worlds-manager errors to validation errors
      if (error instanceof NoDeployedScenesError) {
        throw new ValidationError(
          `Invalid spawnCoordinates "${settings.spawnCoordinates}". The world has no deployed scenes.`
        )
      }
      if (error instanceof SpawnCoordinatesOutOfBoundsError) {
        const { min, max } = error.boundingRectangle
        throw new ValidationError(
          `Invalid spawnCoordinates "${error.spawnCoordinates}". It must be within the world shape rectangle: (${min.x},${min.y}) to (${max.x},${max.y}).`
        )
      }
      throw error
    }

    // Parse old and new spawn coordinates for comparison
    const oldSpawnCoordinates = parseSpawnCoordinates(result.oldSpawnCoordinates)
    const newSpawnCoordinates = parseSpawnCoordinates(result.settings.spawnCoordinates)

    // Emit SNS notifications for settings change
    await emitSettingsChangedEvents(worldName, result.settings, oldSpawnCoordinates, newSpawnCoordinates)

    return result.settings
  }

  function getThumbnailUrl(hash: string): string {
    return `${baseUrl}/contents/${hash}`
  }

  async function emitSettingsChangedEvents(
    worldName: string,
    settings: WorldSettings,
    oldSpawnCoordinates: Coordinate | null,
    newSpawnCoordinates: Coordinate | null
  ): Promise<void> {
    const timestamp = Date.now()
    const events: (WorldSettingsChangedEvent | WorldSpawnCoordinateSetEvent)[] = []

    // Build the settings changed event (without spawn coordinates)
    const settingsChangedEvent: WorldSettingsChangedEvent = {
      type: Events.Type.WORLD,
      subType: Events.SubType.Worlds.WORLD_SETTINGS_CHANGED,
      key: worldName,
      timestamp,
      metadata: {
        title: settings.title,
        description: settings.description,
        contentRating: settings.contentRating,
        skyboxTime: settings.skyboxTime,
        categories: settings.categories,
        singlePlayer: settings.singlePlayer,
        showInPlaces: settings.showInPlaces,
        thumbnailUrl: settings.thumbnailHash ? getThumbnailUrl(settings.thumbnailHash) : undefined
      }
    }
    events.push(settingsChangedEvent)

    // Check if spawn coordinates changed using areCoordinatesEqual
    const spawnCoordinatesChanged =
      newSpawnCoordinates !== null && !areCoordinatesEqual(oldSpawnCoordinates, newSpawnCoordinates)

    if (spawnCoordinatesChanged) {
      const spawnCoordinateSetEvent: WorldSpawnCoordinateSetEvent = {
        type: Events.Type.WORLD,
        subType: Events.SubType.Worlds.WORLD_SPAWN_COORDINATE_SET,
        key: worldName,
        timestamp,
        metadata: {
          name: worldName,
          oldCoordinate: oldSpawnCoordinates,
          newCoordinate: newSpawnCoordinates
        }
      }
      events.push(spawnCoordinateSetEvent)
    }

    await snsClient.publishMessages(events)
  }

  return {
    getWorldSettings,
    updateWorldSettings
  }
}
