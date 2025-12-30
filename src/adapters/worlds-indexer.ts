import { AppComponents, IWorldsIndexer, WorldData, WorldsIndex } from '../types'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export async function createWorldsIndexerComponent({
  worldsManager
}: Pick<AppComponents, 'worldsManager'>): Promise<IWorldsIndexer> {
  async function getIndex(): Promise<WorldsIndex> {
    const worlds = await worldsManager.getRawWorldRecords()
    const index: WorldData[] = []

    for (const world of worlds) {
      const scenes = await worldsManager.getWorldScenes(world.name)

      // Skip worlds with no scenes
      if (scenes.length === 0) {
        continue
      }

      const sceneData: SceneData[] = scenes.map((scene) => {
        const entity = scene.entity
        const thumbnailFile = entity.content?.find(
          (content: ContentMapping) => content.file === entity.metadata?.display?.navmapThumbnail
        )

        return {
          id: scene.id,
          title: entity.metadata?.display?.title || '',
          description: entity.metadata?.display?.description || '',
          thumbnail: thumbnailFile?.hash,
          pointers: scene.parcels, // Use actual parcels from world_scenes table
          runtimeVersion: entity.metadata?.runtimeVersion,
          timestamp: entity.timestamp || Date.now()
        }
      })

      index.push({
        name: world.name,
        scenes: sceneData
      })
    }

    return { index, timestamp: Date.now() }
  }

  return {
    getIndex
  }
}
