import {
  AppComponents,
  GetRawWorldRecordsOptions,
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
  // The index is built by fanning out one scene query per world, so the number of worlds fetched
  // bounds the per-request work. Pagination options are forwarded to keep that bound in the
  // caller's hands (the HTTP handler caps the page size).
  async function getIndex(options?: GetRawWorldRecordsOptions): Promise<WorldsIndex> {
    const { records: worlds } = await worldsManager.getRawWorldRecords({}, options)
    const index: WorldData[] = []

    for (const world of worlds) {
      const { scenes } = await worldsManager.getWorldScenes(
        { worldName: world.name },
        { orderBy: SceneOrderBy.CreatedAt, orderDirection: OrderDirection.Desc }
      )

      if (scenes.length === 0) {
        continue
      }

      const sceneData: SceneData[] = scenes.map((scene) => {
        const entity = scene.entity
        const thumbnailFile = entity.content?.find(
          (content: ContentMapping) => content.file === entity.metadata?.display?.navmapThumbnail
        )
        return {
          id: scene.entityId,
          title: entity.metadata?.display?.title || '',
          description: entity.metadata?.display?.description || '',
          thumbnail: thumbnailFile?.hash,
          pointers: scene.parcels,
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
