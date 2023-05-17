import { AppComponents, IWorldsIndexer, WorldMetadata, WorldStatus } from '../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'

export async function createWorldsIndexerComponent({
  commsAdapter,
  logs,
  marketplaceSubGraph,
  storage,
  worldsManager
}: Pick<
  AppComponents,
  'commsAdapter' | 'logs' | 'marketplaceSubGraph' | 'storage' | 'worldsManager'
>): Promise<IWorldsIndexer> {
  const logger = logs.getLogger('worlds-indexer')

  const globalIndexFile = 'global-index.json'

  const getWalletsForNames = async (deployedWorldsNames: string[]) => {
    const subQueries = deployedWorldsNames
      .map((name) => name.toLowerCase().replace('.dcl.eth', ''))
      .map(
        (name) => `
          ${name}: nfts(
            where: { name_starts_with_nocase: "${name}", name_ends_with_nocase: "${name}", category: ens }
            orderBy: name
          ) {
            name
            owner {
              id
            }
          }
    `
      )
    const query = `
      query {
        ${subQueries.join('\n')}
      }`
    const queryResult = await marketplaceSubGraph.query<any>(query)

    const result: any = {}
    for (const name of deployedWorldsNames) {
      const sanitizedName = name.toLowerCase().replace('.dcl.eth', '')
      const found = queryResult[sanitizedName].filter(
        (nft: any) => `${nft.name.toLowerCase()}.dcl.eth` === name.toLowerCase()
      )
      result[name] = found[0]?.owner?.id
    }

    return result
  }

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

    const allWallets = await getWalletsForNames(deployedWorldsNames)
    for (const worldName of deployedWorldsNames) {
      const entity = await worldsManager.getEntityForWorld(worldName)
      if (!entity) {
        continue
      }
      index[worldName] = {
        name: worldName,
        owner: allWallets[worldName],
        indexInPlaces: !entity.metadata?.worldConfiguration?.placesConfig?.optOut,
        scenes: [
          {
            [`${entity.id}`]: {
              title: entity.metadata?.display?.title,
              description: entity.metadata?.display?.description,
              pointers: entity.pointers
            }
          }
        ]
      }
    }
    await storage.storeStream(globalIndexFile, bufferToStream(stringToUtf8Bytes(JSON.stringify(index))))
    logger.info(`Done indexing`)
  }

  async function getIndex(): Promise<Map<string, WorldMetadata>> {
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
