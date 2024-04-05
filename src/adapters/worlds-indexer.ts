import { AppComponents, IWorldsIndexer, WorldData, WorldsIndex } from '../types'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export async function createWorldsIndexerComponent({
  worldsManager
}: Pick<AppComponents, 'worldsManager'>): Promise<IWorldsIndexer> {
  async function getIndex(): Promise<WorldsIndex> {
    const deployedEntities = await worldsManager.getDeployedWorldEntities()
    const byName: Map<string, WorldData> = deployedEntities
      .map((entity): WorldData => {
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
      .reduce((acc: Map<string, WorldData>, data) => {
        const worldData = acc.get(data.name)
        if (worldData) {
          worldData.scenes.push(data.scenes[0])
        } else {
          acc.set(data.name, data)
        }
        return acc
      }, new Map())

    const index = Array.from(byName.values())
    return { index, timestamp: Date.now() }
  }

  return {
    getIndex
  }
}
