import { AppComponents, IWorldsIndexer, WorldData, WorldsIndex, WorldStatus } from '../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

const GLOBAL_INDEX_FILE = 'global-index.json'

export async function createWorldsIndexerComponent({
  commsAdapter,
  logs,
  storage,
  worldsManager
}: Pick<AppComponents, 'commsAdapter' | 'logs' | 'storage' | 'worldsManager'>): Promise<IWorldsIndexer> {
  const logger = logs.getLogger('worlds-indexer')

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

  async function createIndex(): Promise<WorldsIndex> {
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

    const indexData: WorldsIndex = { index, timestamp: Date.now() }
    await storage.storeStream(GLOBAL_INDEX_FILE, bufferToStream(stringToUtf8Bytes(JSON.stringify(indexData))))
    logger.info('Done indexing')

    return indexData
  }

  async function getIndex(): Promise<WorldsIndex> {
    const content = await storage.retrieve(GLOBAL_INDEX_FILE)
    let indexdata: WorldsIndex

    if (!content) {
      indexdata = await createIndex()
    } else {
      indexdata = JSON.parse((await streamToBuffer(await content.asStream())).toString())
      // if older than 10 minutes create a new one
      if (Date.now() - indexdata.timestamp > 10 * 60 * 1000) {
        indexdata = await createIndex()
      }
    }

    await addLiveData(indexdata.index)

    return indexdata
  }

  return {
    getIndex
  }
}
