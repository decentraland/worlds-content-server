import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { InvalidRequestError } from '@dcl/http-commons'
import { InvalidAccessError, InvalidWorldError, SceneNotFoundError } from '../../logic/comms'

type CommsMetadata = {
  secret?: string
}

export async function worldCommsHandler(
  context: HandlerContextWithPath<'comms', '/worlds/:worldName/comms' | '/worlds/:worldName/scenes/:sceneId/comms'> &
    DecentralandSignatureContext<CommsMetadata>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { comms }
  } = context

  const { worldName } = context.params
  const sceneId = 'sceneId' in context.params ? context.params.sceneId : undefined
  const authMetadata = context.verification?.authMetadata
  if (!authMetadata) {
    throw new InvalidRequestError('Access denied, invalid metadata')
  }

  const identity = context.verification!.auth

  const accessOptions = { secret: authMetadata.secret }

  try {
    let fixedAdapter: string
    if (sceneId) {
      fixedAdapter = await comms.getSceneRoomConnectionString(identity, worldName, sceneId, accessOptions)
    } else {
      fixedAdapter = await comms.getWorldRoomConnectionString(identity, worldName, accessOptions)
    }

    return {
      status: 200,
      body: {
        fixedAdapter
      }
    }
  } catch (error) {
    if (error instanceof InvalidAccessError) {
      return {
        status: 403,
        body: { error: error.message }
      }
    } else if (error instanceof InvalidWorldError || error instanceof SceneNotFoundError) {
      return {
        status: 404,
        body: { error: error.message }
      }
    }

    throw error
  }
}
