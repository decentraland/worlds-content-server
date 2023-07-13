import { WorldMetadata } from '../types'

export function migrateMetadata(metadata: WorldMetadata): WorldMetadata {
  const { config } = metadata as any

  // Deprecated dclName
  if (config.dclName) {
    config.name = config.dclName
    delete config.dclName
  }

  // Deprecated minimapVisible
  if (config.minimapVisible) {
    config.miniMapConfig = { visible: config.minimapVisible }
    delete config.minimapVisible
  }

  // Deprecated minimapVisible
  if (config.skybox) {
    config.skyboxConfig = { fixedTime: config.skybox }
    delete config.skybox
  }

  return {
    ...metadata,
    config
  } as WorldMetadata
}
