import { WorldRuntimeMetadata } from '../types'
import { Entity, WorldConfiguration } from '@dcl/schemas'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'
import { entityByTimestampDescending } from './utils'

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

export function extractWorldRuntimeMetadata(worldName: string, entities: Entity[]): WorldRuntimeMetadata {
  const mergedWorldConfiguration = {
    name: worldName,
    entityIds: entities.map(({ id }) => id)
  } as WorldRuntimeMetadata

  function resolveFilename(entity: Entity, filename: string | undefined): string | undefined {
    if (filename) {
      const file = entity.content.find((content: ContentMapping) => content.file === filename)
      if (file) {
        return file.hash
      }
    }
    return undefined
  }

  // Assuming the most recently deployed (newest) scene is the one to determine the "final" runtime metadata;
  // We set the values from each scene in the reverse order they were deployed, so the last one will be the final one
  const sortedEntities = entities.slice().sort(entityByTimestampDescending)
  for (const sortedEntity of sortedEntities) {
    const migrated = migrateConfiguration(worldName, sortedEntity.metadata?.worldConfiguration)
    mergedWorldConfiguration.fixedAdapter ||= migrated.fixedAdapter
    mergedWorldConfiguration.minimapDataImage ||= resolveFilename(sortedEntity, migrated.miniMapConfig?.dataImage)
    mergedWorldConfiguration.minimapEstateImage ||= resolveFilename(sortedEntity, migrated.miniMapConfig?.estateImage)
    if (mergedWorldConfiguration.minimapVisible === undefined && migrated.miniMapConfig?.visible !== undefined) {
      mergedWorldConfiguration.minimapVisible = migrated.miniMapConfig.visible
    }
    if (mergedWorldConfiguration.skyboxFixedTime === undefined && migrated.skyboxConfig?.fixedTime !== undefined) {
      mergedWorldConfiguration.skyboxFixedTime ||= migrated.skyboxConfig.fixedTime
    }
    mergedWorldConfiguration.skyboxTextures ||= migrated.skyboxConfig?.textures
      ? migrated.skyboxConfig?.textures?.map((texture) => resolveFilename(sortedEntity, texture)!)
      : undefined
    mergedWorldConfiguration.thumbnailFile ||= resolveFilename(
      sortedEntity,
      sortedEntity.metadata?.display?.navmapThumbnail
    )
  }
  mergedWorldConfiguration.minimapVisible = Boolean(mergedWorldConfiguration.minimapVisible)

  return mergedWorldConfiguration
}
