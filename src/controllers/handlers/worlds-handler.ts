import { IHttpServerComponent } from '@dcl/core-commons'
import { InvalidRequestError, getPaginationParams } from '@dcl/http-commons'
import { EthAddress } from '@dcl/schemas'
import { HandlerContextWithPath, WorldInfo, WorldsOrderBy, OrderDirection } from '../../types'

// Caps the free-text search term length. The term feeds leading-wildcard ILIKE and pg_trgm
// similarity over several columns (sequential scans), so an unbounded term lets an anonymous
// caller drive arbitrarily expensive queries. 64 chars comfortably fits any real world name/title.
export const MAX_SEARCH_TERM_LENGTH = 64

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
  deployed_scenes: number
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
    blocked_since: world.blockedSince?.toISOString() ?? null,
    deployed_scenes: world.deployedScenes
  }
}

export async function getWorldsHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/worlds'>
): Promise<IHttpServerComponent.IResponse> {
  const { limit, offset } = getPaginationParams(ctx.url.searchParams)

  // Extract optional query parameters
  const deployer = ctx.url.searchParams.get('authorized_deployer') ?? undefined
  const trimmedSearch = ctx.url.searchParams.get('search')?.trim()
  const search = trimmedSearch ? trimmedSearch : undefined
  const hasDeployedScenesParam = ctx.url.searchParams.get('has_deployed_scenes')
  const hasDeployedScenes = hasDeployedScenesParam !== null ? hasDeployedScenesParam === 'true' : undefined

  // Validate authorized_deployer is a valid Ethereum address if provided
  if (deployer && !EthAddress.validate(deployer)) {
    throw new InvalidRequestError(`Invalid authorized_deployer address: ${deployer}. Must be a valid Ethereum address.`)
  }

  // Bound the search term length to keep the ILIKE/trigram scan cost predictable
  if (search !== undefined && search.length > MAX_SEARCH_TERM_LENGTH) {
    throw new InvalidRequestError(`Invalid search parameter: must be at most ${MAX_SEARCH_TERM_LENGTH} characters.`)
  }
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
    { authorized_deployer: deployer, search, has_deployed_scenes: hasDeployedScenes },
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
