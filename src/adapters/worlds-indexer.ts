import {
  AppComponents,
  IWorldsIndexer,
  SceneData,
  WorldData,
  WorldsIndex,
  SceneOrderBy,
  OrderDirection
} from '../types'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export async function createWorldsIndexerComponent({
  worldsManager
}: Pick<AppComponents, 'worldsManager'>): Promise<IWorldsIndexer> {
  async function getIndex(): Promise<WorldsIndex> {
    const worlds = await worldsManager.getRawWorldRecords()
    const index: WorldData[] = []

    for (const world of worlds) {
      // Get the last deployed scene (most recently created) for this world
      const { scenes } = await worldsManager.getWorldScenes(
        { worldName: world.name },
        { limit: 1, orderBy: SceneOrderBy.CreatedAt, orderDirection: OrderDirection.Desc }
      )

      // Skip worlds with no scenes
      if (scenes.length === 0) {
        continue
      }

      const scene = scenes[0]
      const entity = scene.entity
      const thumbnailFile = entity.content?.find(
        (content: ContentMapping) => content.file === entity.metadata?.display?.navmapThumbnail
      )

      const sceneData: SceneData = {
        id: scene.entityId,
        title: entity.metadata?.display?.title || '',
        description: entity.metadata?.display?.description || '',
        thumbnail: thumbnailFile?.hash,
        pointers: scene.parcels,
        runtimeVersion: entity.metadata?.runtimeVersion,
        timestamp: entity.timestamp || Date.now()
      }

      index.push({
        name: world.name,
        scenes: [sceneData]
      })
    }

    return { index, timestamp: Date.now() }
  }

  return {
    getIndex
  }
}
