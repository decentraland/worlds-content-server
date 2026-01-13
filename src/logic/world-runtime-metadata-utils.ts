import { WorldRuntimeMetadata } from '../types'
import { Entity, WorldConfiguration } from '@dcl/schemas'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export function migrateConfiguration(worldName: string, worldConfiguration: WorldConfiguration): WorldConfiguration {
  // Old deployments may not even have a worldConfiguration
  if (!worldConfiguration) {
    return {
      name: worldName
    }
  }

  const cloned = JSON.parse(JSON.stringify(worldConfiguration)) as any
  // Deprecated dclName
  if (cloned.dclName) {
    cloned.name = cloned.dclName
    delete cloned.dclName
  }

  // Deprecated minimapVisible
  if (cloned.minimapVisible) {
    cloned.miniMapConfig = { visible: cloned.minimapVisible }
    delete cloned.minimapVisible
  }

  // Deprecated minimapVisible
  if (cloned.skybox) {
    cloned.skyboxConfig = { fixedTime: cloned.skybox }
    delete cloned.skybox
  }

  return cloned as WorldConfiguration
}

export function extractWorldRuntimeMetadata(worldName: string, entity: Entity): WorldRuntimeMetadata {
  const migratedWorldConfiguration = migrateConfiguration(worldName, entity.metadata?.worldConfiguration)

  function resolveFilename(filename: string | undefined): string | undefined {
    if (filename) {
      const file = entity.content.find((content: ContentMapping) => content.file === filename)
      if (file) {
        return file.hash
      }
    }
    return undefined
  }

  return {
    name: migratedWorldConfiguration.name || worldName,
    entityIds: [entity.id],
    fixedAdapter: migratedWorldConfiguration.fixedAdapter,
    minimapDataImage: resolveFilename(migratedWorldConfiguration.miniMapConfig?.dataImage),
    minimapEstateImage: resolveFilename(migratedWorldConfiguration.miniMapConfig?.estateImage),
    minimapVisible: migratedWorldConfiguration.miniMapConfig?.visible ?? false,
    skyboxFixedTime: migratedWorldConfiguration.skyboxConfig?.fixedTime,
    skyboxTextures: migratedWorldConfiguration.skyboxConfig?.textures
      ? migratedWorldConfiguration.skyboxConfig?.textures?.map((texture) => resolveFilename(texture)!)
      : undefined,
    thumbnailFile: resolveFilename(entity.metadata?.display?.navmapThumbnail)
  }
}

/**
 * Extracts the spawn point parcel coordinate from an Entity's metadata
 *
 * The spawn coordinate is determined using the following priority:
 * 1. The scene's base parcel (scene.base)
 * 2. The first parcel in the scene's parcels array (scene.parcels[0])
 *
 * @param entity - The scene entity containing metadata with scene information
 * @returns The parcel coordinate string (e.g., "0,0")
 * @throws {Error} If no valid spawn coordinates are found in the entity metadata
 */
export function extractSpawnCoordinates(entity: Entity): string {
  const scene = entity.metadata?.scene
  const parcel = scene?.base || (scene?.parcels && scene.parcels[0])
  if (parcel && typeof parcel === 'string') {
    return parcel
  }

  throw new Error('No spawn coordinates found in entity metadata')
}

export function buildWorldRuntimeMetadata(worldName: string, scenes: any[]): WorldRuntimeMetadata {
  // Derive runtime metadata from scenes
  if (scenes.length > 0) {
    const firstScene = scenes[0]
    return extractWorldRuntimeMetadata(worldName, {
      ...firstScene.entity,
      id: firstScene.entityId
    })
  }

  // Default empty metadata
  return {
    name: worldName,
    entityIds: [],
    minimapVisible: false
  }
}
