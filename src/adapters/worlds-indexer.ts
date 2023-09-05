import { AppComponents, IWorldsIndexer, WorldData, WorldsIndex } from '../types'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export async function createWorldsIndexerComponent({
  worldsManager
}: Pick<AppComponents, 'worldsManager'>): Promise<IWorldsIndexer> {
  async function getIndex(): Promise<WorldsIndex> {
    const deployedEntities = await worldsManager.getDeployedWorldEntities()
    const index: WorldData[] = deployedEntities.map((entity) => {
      const worldName = entity.metadata.worldConfiguration.name
      const thumbnailFile = entity.content.find(
        (content: ContentMapping) => content.file === entity.metadata.display?.navmapThumbnail
      )
      return {
        name: worldName,
        scenes: [
          {
            id: entity.id,
            title: entity.metadata?.display?.title,
            description: entity.metadata?.display?.description,
            thumbnail: thumbnailFile?.hash,
            pointers: entity.pointers,
            runtimeVersion: entity.metadata?.runtimeVersion,
            timestamp: entity.timestamp
          }
        ]
      }
    })

    return { index, timestamp: Date.now() }
  }

  return {
    getIndex
  }
}
