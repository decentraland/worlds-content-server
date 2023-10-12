import { CommsStatus, HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export type ContentStatus = {
  commitHash: string
  worldsCount: { ens: number; dcl: number }
}

export type StatusResponse = {
  content: ContentStatus
  comms: CommsStatus
}

export async function statusHandler(
  context: HandlerContextWithPath<'commsAdapter' | 'config' | 'worldsManager', '/status'>
): Promise<IHttpServerComponent.IResponse> {
  const { commsAdapter, config, worldsManager } = context.components

  const commitHash = (await config.getString('COMMIT_HASH')) || 'unknown'

  const worldsCount = await worldsManager.getDeployedWorldCount()
  const commsStatus = await commsAdapter.status()

  const status: StatusResponse = {
    content: {
      commitHash,
      worldsCount
    },
    comms: {
      ...commsStatus,
      details: undefined
    }
  }

  return {
    status: 200,
    body: status
  }
}
