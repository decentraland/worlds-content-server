import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { PulseUnavailableError } from '../../logic/pulse'

export async function getLiveDataHandler(
  context: HandlerContextWithPath<'commsAdapter', '/live-data'>
): Promise<IHttpServerComponent.IResponse> {
  const { commsAdapter } = context.components

  let commsStatus
  try {
    commsStatus = await commsAdapter.status()
  } catch (error) {
    if (error instanceof PulseUnavailableError) {
      return { status: 503, body: { error: 'Service Unavailable', message: error.message } }
    }
    throw error
  }

  const data = {
    totalUsers: commsStatus.users,
    perWorld: commsStatus.details
  }

  return {
    status: 200,
    body: { data: data, lastUpdated: new Date(commsStatus.timestamp).toISOString() }
  }
}
