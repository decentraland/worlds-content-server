import { CommsStatus, HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { PulseUnavailableError } from '../../logic/pulse'

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

  let commsStatus: CommsStatus
  try {
    commsStatus = await commsAdapter.status()
  } catch (error) {
    if (error instanceof PulseUnavailableError) {
      return { status: 503, body: { error: 'Service Unavailable', message: error.message } }
    }
    throw error
  }

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
