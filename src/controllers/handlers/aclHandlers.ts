import { IHttpServerComponent } from '@well-known-components/interfaces'
import { HandlerContextWithPath } from '../../types'

export async function getAclHandler(
  ctx: HandlerContextWithPath<
    'config' | 'logs' | 'namePermissionChecker' | 'metrics' | 'storage' | 'sns' | 'validator',
    '/acl'
  >
): Promise<IHttpServerComponent.IResponse> {
  const logger = ctx.components.logs.getLogger('deploy')
  try {
    return {
      status: 200,
      body: {
        acl: {}
      }
    }
  } catch (err: any) {
    logger.error(err)
    throw err
  }
}

export async function postAclHandler(
  ctx: HandlerContextWithPath<
    'config' | 'logs' | 'namePermissionChecker' | 'metrics' | 'storage' | 'sns' | 'validator',
    '/acl'
  >
): Promise<IHttpServerComponent.IResponse> {
  const logger = ctx.components.logs.getLogger('deploy')
  try {
    return {
      status: 200,
      body: {
        acl: {}
      }
    }
  } catch (err: any) {
    logger.error(err)
    throw err
  }
}
