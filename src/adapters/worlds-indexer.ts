import { AppComponents, IWorldsIndexer, WorldStatus } from '../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export async function createWorldsIndexerComponent({
  commsAdapter,
  logs,
  engagementStatsFetcher,
  storage,
  worldsManager
}: Pick<
  AppComponents,
  'commsAdapter' | 'engagementStatsFetcher' | 'logs' | 'storage' | 'worldsManager'
>): Promise<IWorldsIndexer> {
  const logger = logs.getLogger('worlds-indexer')

  const globalIndexFile = 'global-index.json'

  const addLiveData = async (staticIndex: any) => {
    const commsStatus = await commsAdapter.status()
    const usersByWorld = commsStatus.details?.reduce((accum: any, world: WorldStatus) => {
      accum[world.worldName] = world
      return accum
    }, {})

    console.log(commsStatus)

    for (const worldName in staticIndex) {
      staticIndex[worldName].currentUsers = usersByWorld?.[worldName]?.users ?? 0
    }
  }

  async function createIndex(): Promise<void> {
    logger.info(`Creating index of all the data from all the worlds deployed in the server`)
    const deployedWorldsNames = await worldsManager.getDeployedWorldsNames()
    const index: any = {}

    const engagementStats = await engagementStatsFetcher.for(deployedWorldsNames)
    for (const worldName of deployedWorldsNames) {
      const entity = await worldsManager.getEntityForWorld(worldName)
      if (!entity) {
        continue
      }
      const thumbnailFile = entity.content.find(
        (content: ContentMapping) => content.file === entity.metadata?.display?.navmapThumbnail
      )
      index[worldName] = {
        name: worldName,
        owner: engagementStats.ownerOf(worldName),
        indexInPlaces:
          !entity.metadata?.worldConfiguration?.placesConfig?.optOut && engagementStats.shouldBeIndexed(worldName),
        scenes: {
          [`${entity.id}`]: {
            title: entity.metadata?.display?.title,
            description: entity.metadata?.display?.description,
            thumbnail: thumbnailFile!.hash,
            pointers: entity.pointers,
            runtimeVersion: entity.metadata?.runtimeVersion
          }
        }
      }
    }
    await storage.storeStream(globalIndexFile, bufferToStream(stringToUtf8Bytes(JSON.stringify(index))))
    logger.info(`Done indexing`)
  }

  async function getIndex(): Promise<Record<string, any>> {
    // await createIndex() // TODO Remove
    const content = await storage.retrieve(globalIndexFile)
    if (!content) {
      return Promise.reject('No global index found')
    }
    const staticIndex = JSON.parse((await streamToBuffer(await content.asStream())).toString())

    await addLiveData(staticIndex)

    console.log({ staticIndex })
    return staticIndex
  }

  return {
    createIndex,
    getIndex
  }
}
