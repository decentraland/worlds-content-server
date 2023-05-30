import { AppComponents, IWorldsIndexer, WorldData, WorldStatus } from '../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export async function createWorldsIndexerComponent({
  commsAdapter,
  logs,
  storage,
  worldsManager
}: Pick<AppComponents, 'commsAdapter' | 'logs' | 'storage' | 'worldsManager'>): Promise<IWorldsIndexer> {
  const logger = logs.getLogger('worlds-indexer')

  const globalIndexFile = 'global-index.json'

  const addLiveData = async (staticIndex: WorldData[]) => {
    const commsStatus = await commsAdapter.status()
    const usersByWorld = commsStatus.details?.reduce((accum: Record<string, WorldStatus>, world: WorldStatus) => {
      accum[world.worldName] = world
      return accum
    }, {})

    for (const worldData of staticIndex) {
      worldData.currentUsers = usersByWorld?.[worldData.name]?.users ?? 0
    }
  }

  async function createIndex(): Promise<void> {
    logger.info('Creating index of all the data from all the worlds deployed in the server')
    const deployedWorldsNames = await worldsManager.getDeployedWorldsNames()
    const index: WorldData[] = []

    for (const worldName of deployedWorldsNames) {
      const entity = await worldsManager.getEntityForWorld(worldName)
      if (!entity) {
        continue
      }
      const thumbnailFile = entity.content.find(
        (content: ContentMapping) => content.file === entity.metadata?.display?.navmapThumbnail
      )
      index.push({
        name: worldName,
        scenes: [
          {
            id: entity.id,
            title: entity.metadata?.display?.title,
            description: entity.metadata?.display?.description,
            thumbnail: thumbnailFile!.hash,
            pointers: entity.pointers,
            runtimeVersion: entity.metadata?.runtimeVersion,
            timestamp: entity.timestamp
          }
        ]
      })
    }
    await storage.storeStream(globalIndexFile, bufferToStream(stringToUtf8Bytes(JSON.stringify(index))))
    logger.info('Done indexing')
  }

  async function getIndex(): Promise<WorldData[]> {
    const content = await storage.retrieve(globalIndexFile)
    if (!content) {
      return Promise.reject('No global index found')
    }
    const staticIndex = JSON.parse((await streamToBuffer(await content.asStream())).toString())

    await addLiveData(staticIndex)

    return staticIndex
  }

  return {
    createIndex,
    getIndex
  }
}
