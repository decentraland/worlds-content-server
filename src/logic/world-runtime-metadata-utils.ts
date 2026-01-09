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
 * Extracts spawn point parcel coordinate from an Entity's metadata.
 * Returns a parcel coordinate string like "0,0" from scene.base or scene.parcels[0],
 * or null if no scene metadata found.
 */
export function extractSpawnCoordinates(entity: Entity): string | null {
  const scene = entity.metadata?.scene
  if (!scene) {
    return null
  }

  const parcel = scene.base || (scene.parcels && scene.parcels[0])
  if (parcel && typeof parcel === 'string') {
    return parcel
  }

  return null
}

export function buildWorldRuntimeMetadata(worldName: string, scenes: any[]): WorldRuntimeMetadata {
  // Derive runtime metadata from scenes
  if (scenes.length > 0) {
    const firstScene = scenes[0]
    return extractWorldRuntimeMetadata(worldName, {
      ...firstScene.entity,
      id: firstScene.id
    })
  }

  // Default empty metadata
  return {
    name: worldName,
    entityIds: [],
    minimapVisible: false
  }
}
