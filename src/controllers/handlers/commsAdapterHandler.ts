import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export async function commsAdapterHandler(
  context: HandlerContextWithPath<'config' | 'worldsManager', '/get-comms-adapter/:roomId'>
): Promise<IHttpServerComponent.IResponse> {
  const { config } = context.components
  const roomId = context.params.roomId

  const fixedAdapter = await config.requireString('COMMS_FIXED_ADAPTER')
  const fixedAdapterPrefix = fixedAdapter.substring(0, fixedAdapter.lastIndexOf('/'))

  console.log(`Resolving comms adapter to: ${fixedAdapterPrefix}/${roomId}`)

  return {
    status: 200,
    body: {
      fixedAdapter: `${fixedAdapterPrefix}/${roomId}`
    }
  }
}
