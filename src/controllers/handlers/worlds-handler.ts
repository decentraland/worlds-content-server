import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError, getPaginationParams } from '@dcl/platform-server-commons'
import { HandlerContextWithPath, WorldInfo, WorldsOrderBy, OrderDirection } from '../../types'

type SnakeCaseWorldInfo = {
  name: string
  owner: string
  title: string | null
  description: string | null
  shape: { x1: number; x2: number; y1: number; y2: number } | null
  content_rating: string | null
  spawn_coordinates: string | null
  skybox_time: number | null
  categories: string[] | null
  single_player: boolean | null
  show_in_places: boolean | null
  thumbnail_hash: string | null
  last_deployed_at: string | null
  blocked_since: string | null
}

function toSnakeCaseWorldInfo(world: WorldInfo): SnakeCaseWorldInfo {
  return {
    name: world.name,
    owner: world.owner,
    title: world.title,
    description: world.description,
    shape: world.shape,
    content_rating: world.contentRating,
    spawn_coordinates: world.spawnCoordinates,
    skybox_time: world.skyboxTime,
    categories: world.categories,
    single_player: world.singlePlayer,
    show_in_places: world.showInPlaces,
    thumbnail_hash: world.thumbnailHash,
    last_deployed_at: world.lastDeployedAt?.toISOString() ?? null,
    blocked_since: world.blockedSince?.toISOString() ?? null
  }
}

export async function getWorldsHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/worlds'>
): Promise<IHttpServerComponent.IResponse> {
  const { limit, offset } = getPaginationParams(ctx.url.searchParams)

  // Extract optional query parameters
  const canDeploy = ctx.url.searchParams.get('can_deploy') ?? undefined
  const search = ctx.url.searchParams.get('search') ?? undefined
  const sortParam = ctx.url.searchParams.get('sort') ?? WorldsOrderBy.Name
  const orderParam = ctx.url.searchParams.get('order') ?? OrderDirection.Asc

  // Validate sort parameter using enum values
  const validSortValues = Object.values(WorldsOrderBy)
  if (!validSortValues.includes(sortParam as WorldsOrderBy)) {
    throw new InvalidRequestError(
      `Invalid sort parameter: ${sortParam}. Valid values are: ${validSortValues.join(', ')}`
    )
  }

  // Validate order parameter using enum values
  const validOrderValues = Object.values(OrderDirection)
  if (!validOrderValues.includes(orderParam as OrderDirection)) {
    throw new InvalidRequestError(
      `Invalid order parameter: ${orderParam}. Valid values are: ${validOrderValues.join(', ')}`
    )
  }

  const orderBy = sortParam as WorldsOrderBy
  const orderDirection = orderParam as OrderDirection

  const { worlds, total } = await ctx.components.worldsManager.getWorlds(
    { canDeploy, search },
    { limit, offset, orderBy, orderDirection }
  )

  return {
    status: 200,
    body: {
      worlds: worlds.map(toSnakeCaseWorldInfo),
      total
    }
  }
}
