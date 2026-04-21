import { WorldRuntimeMetadata, WorldScene } from '../types'
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
  const content = entity.content || []

  function resolveFilename(filename: string | undefined): string | undefined {
    if (filename) {
      const file = content.find((c: ContentMapping) => c.file === filename)
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

export function buildWorldRuntimeMetadata(worldName: string, scenes: WorldScene[]): WorldRuntimeMetadata {
  if (scenes.length === 0) {
    return {
      name: worldName,
      entityIds: [],
      minimapVisible: false
    }
  }

  // Take world-level settings (minimap, skybox, thumbnail, fixedAdapter, name)
  // from the most recently deployed scene
  const orderedScenes = [...scenes].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const primaryScene = orderedScenes[0]
  const baseMetadata = extractWorldRuntimeMetadata(worldName, {
    ...primaryScene.entity,
    id: primaryScene.entityId
  })

  return {
    ...baseMetadata,
    entityIds: orderedScenes.map((scene) => scene.entityId)
  }
}
