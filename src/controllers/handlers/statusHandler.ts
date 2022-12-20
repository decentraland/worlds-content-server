import { BaseComponents, GlobalContext } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { RoutedContext } from '@well-known-components/http-server'

export async function createStatusHandler({
  config,
  logs,
  worldsManager
}: Pick<BaseComponents, 'config' | 'logs' | 'worldsManager'>): Promise<
  IHttpServerComponent.IRequestHandler<RoutedContext<GlobalContext, '/status'>>
> {
  const logger = logs.getLogger('status-handler')

  const commitHash = (await config.getString('COMMIT_HASH')) || 'unknown'
  const secret = await config.getString('AUTH_SECRET')
  if (!secret) {
    logger.warn('No secret defined, deployed worlds will not be returned.')
  }

  return async function (context: IHttpServerComponent.DefaultContext) {
    let showWorlds = false
    if (secret) {
      const token = context.request.headers.get('Authorization')?.substring(7) // Remove the "Bearer " part
      if (token && token === secret) {
        showWorlds = true
      }
    }
    const deployedWorlds = await worldsManager.getDeployedWorldsNames()

    return {
      status: 200,
      body: {
        commitHash,
        worlds_count: deployedWorlds.length,
        deployed_names: showWorlds ? deployedWorlds : undefined
      }
    }
  }
}
