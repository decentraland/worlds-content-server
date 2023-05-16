import { AppComponents, IWorldsIndexer, WorldMetadata } from '../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'

function addLiveData(staticIndex: any) {
  const liveData = { currentUsers: 3 }
  staticIndex['world-name.dcl.eth'] = { ...staticIndex['world-name.dcl.eth'], ...liveData }
  return staticIndex
}

export async function createWorldsIndexerComponent({
  logs,
  storage,
  worldsManager
}: Pick<AppComponents, 'logs' | 'storage' | 'worldsManager'>): Promise<IWorldsIndexer> {
  const logger = logs.getLogger('worlds-indexer')

  const globalIndexFile = 'global-index.json'

  async function createIndex(): Promise<void> {
    const deployedWorldsNames = await worldsManager.getDeployedWorldsNames()
    const index = new Map<string, any>()
    for (const deployedWorldsName of deployedWorldsNames) {
      index.set(deployedWorldsName, {})
    }
    await storage.storeStream(globalIndexFile, bufferToStream(stringToUtf8Bytes(JSON.stringify(index))))
  }

  async function getIndex(): Promise<Map<string, WorldMetadata>> {
    const content = await storage.retrieve(globalIndexFile)
    if (!content) {
      return Promise.reject('No global index found')
    }
    const staticIndex = JSON.parse((await streamToBuffer(await content.asStream())).toString())

    return addLiveData(staticIndex)
  }

  return {
    createIndex,
    getIndex
  }
}
