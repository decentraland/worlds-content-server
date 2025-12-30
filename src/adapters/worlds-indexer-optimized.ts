import { AppComponents, IWorldsIndexer, WorldData, WorldsIndex, SceneData } from '../types'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'
import SQL from 'sql-template-strings'

export async function createWorldsIndexerComponent({
  worldsManager,
  database
}: Pick<AppComponents, 'worldsManager' | 'database'>): Promise<IWorldsIndexer> {
  // Cache the index for 1 minute
  let cachedIndex: WorldsIndex | null = null
  let lastCacheTime = 0
  const CACHE_TTL = 60 * 1000 // 1 minute

  async function getIndex(): Promise<WorldsIndex> {
    const now = Date.now()
    
    // Return cached version if still valid
    if (cachedIndex && (now - lastCacheTime) < CACHE_TTL) {
      return cachedIndex
    }

    // OPTIMIZATION 1: Single JOIN query instead of N+1
    const result = await database.query<{
      world_name: string
      entity_id: string
      entity: any
      parcels: string[]
      scene_timestamp: number
    }>(SQL`
      SELECT 
        w.name as world_name,
        ws.entity_id,
        ws.entity,
        ws.parcels,
        EXTRACT(EPOCH FROM ws.created_at)::bigint * 1000 as scene_timestamp
      FROM worlds w
      INNER JOIN world_scenes ws ON w.name = ws.world_name
      WHERE w.entity_id IS NOT NULL
      ORDER BY w.name, ws.created_at
    `)

    // OPTIMIZATION 2: Group scenes by world in-memory (faster than multiple queries)
    const worldsMap = new Map<string, SceneData[]>()
    
    for (const row of result.rows) {
      if (!worldsMap.has(row.world_name)) {
        worldsMap.set(row.world_name, [])
      }

      const entity = row.entity
      const thumbnailFile = entity.content?.find(
        (content: ContentMapping) => content.file === entity.metadata?.display?.navmapThumbnail
      )

      // OPTIMIZATION 3: Only include essential fields in index
      worldsMap.get(row.world_name)!.push({
        id: row.entity_id,
        title: entity.metadata?.display?.title || '',
        description: entity.metadata?.display?.description || '',
        thumbnail: thumbnailFile?.hash,
        pointers: row.parcels,
        runtimeVersion: entity.metadata?.runtimeVersion,
        timestamp: row.scene_timestamp
      })
    }

    const index: WorldData[] = Array.from(worldsMap.entries()).map(([name, scenes]) => ({
      name,
      scenes
    }))

    // Cache the result
    cachedIndex = { index, timestamp: now }
    lastCacheTime = now

    return cachedIndex
  }

  // Method to invalidate cache when needed
  async function invalidateCache(): Promise<void> {
    cachedIndex = null
    lastCacheTime = 0
  }

  return {
    getIndex,
    invalidateCache
  }
}

