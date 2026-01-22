import { HandlerContextWithPath, DeploymentFilters } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export async function getDeploymentsHandler(
  context: HandlerContextWithPath<'worldsManager', '/deployments'>
): Promise<IHttpServerComponent.IResponse> {
  const { worldsManager } = context.components
  const searchParams = context.url.searchParams

  const filters = parseFilters(searchParams)
  const result = await worldsManager.getDeploymentsWithFilters(filters)

  return {
    status: 200,
    body: result
  }
}

const parseFilter = (searchParams: URLSearchParams, paramName: string): string[] | undefined => {
  const param = searchParams.get(paramName)
  if (!param) return undefined

  const values = param
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)

  return values.length > 0 ? values : undefined
}

const parseFilters = (searchParams: URLSearchParams): DeploymentFilters => {
  const limit = parsePaginationParam(searchParams.get('limit'), DEFAULT_LIMIT, MAX_LIMIT)
  const offset = parsePaginationParam(searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER)

  return {
    name: parseFilter(searchParams, 'name'),
    entityIds: parseFilter(searchParams, 'entityId'),
    deployer: parseFilter(searchParams, 'deployer'),
    owner: parseFilter(searchParams, 'owner'),
    limit,
    offset
  }
}

const parsePaginationParam = (value: string | null, defaultValue: number, maxValue: number): number => {
  if (!value) {
    return defaultValue
  }

  const parsedValue = Number(value)
  if (isNaN(parsedValue)) {
    return defaultValue
  }
  if (parsedValue < 0) {
    return 0
  }
  if (parsedValue > maxValue) {
    return maxValue
  }

  return Math.floor(parsedValue)
}
