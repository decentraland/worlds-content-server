import { WorldRuntimeMetadata } from '../types'
import { Entity, WorldConfiguration } from '@dcl/schemas'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export function migrateConfiguration(worldName: string, worldConfiguration: WorldConfiguration): WorldConfiguration {
  const migrated = {} as WorldConfiguration

  // Old deployments may not even have a worldConfiguration
  if (!worldConfiguration) {
    return {
      name: worldName
    }
  }

  const cloned = JSON.parse(JSON.stringify(worldConfiguration)) as any

  // Deprecated dclName
  migrated.name = cloned.dclName || worldConfiguration.name

  // Deprecated minimapVisible
  if (!!cloned.minimapVisible) {
    migrated.miniMapConfig = { visible: !!cloned.minimapVisible }
  }

  // Deprecated skybox
  if (!isNaN(cloned.skybox)) {
    migrated.skyboxConfig = { fixedTime: cloned.skybox }
  }

  if (cloned.miniMapConfig) {
    migrated.miniMapConfig = cloned.miniMapConfig
  }

  if (cloned.skyboxConfig) {
    migrated.skyboxConfig = cloned.skyboxConfig
  }

  if (cloned.placesConfig) {
    migrated.placesConfig = cloned.placesConfig
  }

  if (cloned.fixedAdapter && cloned.fixedAdapter === 'offline:offline') {
    migrated.fixedAdapter = cloned.fixedAdapter
  }

  return migrated as WorldConfiguration
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
