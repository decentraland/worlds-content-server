import { WorldMetadata } from '../types'

export function migrateMetadata(worldName: string, metadata: WorldMetadata): WorldMetadata {
  // console.log('original metadata', metadata, typeof metadata)

  const cloned = structuredClone(metadata) as any

  // Old deployments may not even have a worldConfiguration
  if (!cloned.config) {
    cloned.config = {
      name: worldName
    }
  }

  // Deprecated dclName
  if (cloned.config.dclName) {
    cloned.config.name = cloned.config.dclName
    delete cloned.config.dclName
  }

  // Deprecated minimapVisible
  if (cloned.config.minimapVisible) {
    cloned.config.miniMapConfig = { visible: cloned.config.minimapVisible }
    delete cloned.config.minimapVisible
  }

  // Deprecated minimapVisible
  if (cloned.config.skybox) {
    cloned.config.skyboxConfig = { fixedTime: cloned.config.skybox }
    delete cloned.config.skybox
  }

  // console.log('migrated', cloned)
  return cloned as WorldMetadata
}
