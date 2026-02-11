import {
  AppComponents,
  ContributorDomain,
  GetWorldScenesFilters,
  GetWorldScenesOptions,
  GetWorldScenesResult,
  IWorldsManager,
  WorldMetadata,
  WorldRecord,
  WorldScene,
  WorldSettings,
  WorldBoundingRectangle,
  OrderDirection,
  UpdateWorldSettingsResult
} from '../../src/types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { Entity, EthAddress } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'
import { buildWorldRuntimeMetadata } from '../../src/logic/world-runtime-metadata-utils'
import { AccessSetting, defaultAccess } from '../../src/logic/access'

export async function createWorldsManagerMockComponent({
  coordinates,
  storage
}: Pick<AppComponents, 'coordinates' | 'storage'>): Promise<IWorldsManager> {
  const { extractSpawnCoordinates, calculateBoundingRectangle } = coordinates

  async function getRawWorldRecords(): Promise<{ records: WorldRecord[]; total: number }> {
    const worlds: WorldRecord[] = []
    for await (const key of storage.allFileIds('name-')) {
      const entity = await getEntityForWorld(key.substring(5))
      if (entity) {
        let owner = ''
        const authContent = await storage.retrieve(`${entity.id}.auth`)
        if (authContent) {
          const authChain = JSON.parse((await streamToBuffer(await authContent.asStream())).toString())
          owner = authChain[0]?.payload || ''
        }
        // Extract spawn coordinates from the entity's scene base parcel
        const spawnCoordinates = extractSpawnCoordinates(entity)
        worlds.push({
          name: entity.metadata.worldConfiguration.name,
          owner,
          access: defaultAccess(),
          spawn_coordinates: spawnCoordinates,
          created_at: new Date(1706019701900),
          updated_at: new Date(1706019701900),
          blocked_since: null,
          title: '',
          description: '',
          content_rating: '',
          skybox_time: 0,
          categories: [],
          single_player: false,
          show_in_places: false,
          thumbnail_hash: ''
        })
      }
    }
    return { records: worlds, total: worlds.length }
  }

  async function getEntityForWorld(worldName: string): Promise<Entity | undefined> {
    const metadata = await getMetadataForWorld(worldName)
    if (!metadata || !metadata.scenes || metadata.scenes.length === 0) {
      return undefined
    }

    const scene = metadata.scenes[0]
    return {
      ...scene.entity,
      id: scene.entityId
    }
  }

  async function getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined> {
    const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
    if (!content) {
      return undefined
    }
    const metadata = JSON.parse((await streamToBuffer(await content.asStream())).toString())

    // Convert size strings back to BigInt in scenes
    if (metadata.scenes) {
      metadata.scenes = metadata.scenes.map((scene: any) => ({
        ...scene,
        size: typeof scene.size === 'string' ? BigInt(scene.size) : scene.size
      }))
    }

    // Build runtime metadata from the most recently deployed scene (last in array)
    if (metadata.scenes && metadata.scenes.length > 0) {
      const mostRecentScene = metadata.scenes[metadata.scenes.length - 1]
      metadata.runtimeMetadata = buildWorldRuntimeMetadata(worldName, [mostRecentScene])
    }

    return metadata
  }

  async function storeWorldMetadata(worldName: string, worldMetadata: Partial<WorldMetadata>): Promise<void> {
    const contentMetadata = (await getMetadataForWorld(worldName.toLowerCase())) || {}
    const metadata: Partial<WorldMetadata> = Object.assign({}, contentMetadata, worldMetadata)
    Object.assign(metadata, worldMetadata)

    // Convert BigInt values to strings for JSON serialization
    const serializableMetadata = JSON.stringify(metadata, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )

    await storage.storeStream(
      `name-${worldName.toLowerCase()}`,
      bufferToStream(stringToUtf8Bytes(serializableMetadata))
    )
  }

  async function deployScene(worldName: string, scene: Entity, owner: EthAddress): Promise<void> {
    const parcels: string[] = scene.metadata?.scene?.parcels || []
    const existingMetadata = await getMetadataForWorld(worldName)
    const newScene: WorldScene = {
      worldName: worldName.toLowerCase(),
      entityId: scene.id,
      deployer: owner,
      deploymentAuthChain: [],
      entity: scene,
      parcels,
      size: 0n,
      createdAt: new Date()
    }

    // Filter out existing scenes on these parcels and add the new scene
    const existingScenes = existingMetadata?.scenes || []
    const filteredScenes = existingScenes.filter((s) => !s.parcels.some((p) => parcels.includes(p)))

    // Set spawn coordinates only if this is the first scene (no existing spawn coordinates)
    const newSceneCoordinates = extractSpawnCoordinates(scene)
    const spawnCoordinates = existingMetadata?.spawnCoordinates || newSceneCoordinates

    await storeWorldMetadata(worldName, {
      scenes: [...filteredScenes, newScene],
      spawnCoordinates,
      owner
    })
  }

  async function undeployScene(_worldName: string, _parcels: string[]): Promise<void> {
    // Mock implementation - no-op
  }

  async function getWorldScenes(
    filters?: GetWorldScenesFilters,
    options?: GetWorldScenesOptions
  ): Promise<GetWorldScenesResult> {
    if (!filters?.worldName) {
      return { scenes: [], total: 0 }
    }

    const metadata = await getMetadataForWorld(filters.worldName)
    if (!metadata || !metadata.scenes) {
      return { scenes: [], total: 0 }
    }

    let scenes = [...metadata.scenes]

    // Apply coordinates filter (scenes that contain any of the specified coordinates)
    if (filters.coordinates && filters.coordinates.length > 0) {
      scenes = scenes.filter((s) => s.parcels.some((p) => filters.coordinates!.includes(p)))
    }

    // Apply bounding box filter (scenes that have at least one parcel within the rectangle)
    if (filters.boundingBox) {
      const { x1, x2, y1, y2 } = filters.boundingBox
      const xMin = Math.min(x1, x2)
      const xMax = Math.max(x1, x2)
      const yMin = Math.min(y1, y2)
      const yMax = Math.max(y1, y2)
      scenes = scenes.filter((s) =>
        s.parcels.some((p) => {
          const [x, y] = p.split(',').map(Number)
          return x >= xMin && x <= xMax && y >= yMin && y <= yMax
        })
      )
    }

    const total = scenes.length

    // Apply sorting
    const orderDirection = options?.orderDirection ?? OrderDirection.Asc
    scenes.sort((a, b) => {
      const aValue = a.createdAt.getTime()
      const bValue = b.createdAt.getTime()
      return orderDirection === OrderDirection.Asc ? aValue - bValue : bValue - aValue
    })

    const limit = options?.limit ?? scenes.length
    const offset = options?.offset ?? 0

    return {
      scenes: scenes.slice(offset, offset + limit),
      total
    }
  }

  async function updateWorldSettings(
    worldName: string,
    _owner: EthAddress,
    settings: WorldSettings
  ): Promise<UpdateWorldSettingsResult> {
    const existingMetadata = await getMetadataForWorld(worldName)
    const oldSpawnCoordinates = existingMetadata?.spawnCoordinates || null

    // Merge new settings with existing settings
    const updatedSettings: WorldSettings = {
      ...existingMetadata,
      ...settings
    }

    await storeWorldMetadata(worldName, {
      spawnCoordinates: updatedSettings.spawnCoordinates || null
    })

    return {
      settings: updatedSettings,
      oldSpawnCoordinates
    }
  }

  async function getWorldSettings(worldName: string): Promise<WorldSettings | undefined> {
    const metadata = await getMetadataForWorld(worldName)
    if (!metadata) {
      return undefined
    }
    return {
      spawnCoordinates: metadata.spawnCoordinates || undefined
    }
  }

  async function getTotalWorldSize(_worldName: string): Promise<bigint> {
    return 0n
  }

  async function getWorldBoundingRectangle(worldName: string): Promise<WorldBoundingRectangle | undefined> {
    const metadata = await getMetadataForWorld(worldName)
    if (!metadata || !metadata.scenes) {
      return undefined
    }
    const allParcels = metadata.scenes.flatMap((scene) => scene.parcels)
    return calculateBoundingRectangle(allParcels)
  }

  async function storeAccess(worldName: string, access: AccessSetting): Promise<void> {
    await storeWorldMetadata(worldName, { access })
  }

  async function getDeployedWorldCount(): Promise<{ ens: number; dcl: number }> {
    const acc = { ens: 0, dcl: 0 }
    for await (const name of storage.allFileIds('name-')) {
      if (name.endsWith('.dcl.eth')) {
        acc.dcl++
      } else {
        acc.ens++
      }
    }
    return acc
  }

  async function undeployWorld(worldName: string): Promise<void> {
    await storage.delete([`name-${worldName.toLowerCase()}`])
  }

  async function getEntityForWorlds(worldNames: string[]): Promise<Entity[]> {
    const entities: Entity[] = []
    for (const worldName of worldNames) {
      const entity = await getEntityForWorld(worldName)
      if (entity) {
        entities.push(entity)
      }
    }
    return entities
  }

  async function getContributableDomains(_address: string): Promise<{ domains: ContributorDomain[]; count: number }> {
    // Permissions are now stored in the database (world_permissions table), not in WorldMetadata.
    // This mock cannot access the database, so it returns an empty result.
    // Integration tests should use the real permissionsManager component instead.
    return { domains: [], count: 0 }
  }

  async function getWorlds() {
    return { worlds: [], total: 0 }
  }

  async function getOccupiedParcels() {
    return { parcels: [], total: 0 }
  }

  async function createBasicWorldIfNotExists(_worldName: string, _owner: EthAddress): Promise<void> {
    // Mock implementation - no-op
  }

  async function worldExists(worldName: string): Promise<boolean> {
    const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
    return content !== undefined
  }

  async function getWorldNamesByCommunityId(_communityId: string): Promise<string[]> {
    return []
  }

  return {
    getContributableDomains,
    getRawWorldRecords,
    getDeployedWorldCount,
    getMetadataForWorld,
    getEntityForWorlds,
    deployScene,
    undeployScene,
    storeAccess,
    undeployWorld,
    getWorldScenes,
    updateWorldSettings,
    getWorldSettings,
    getTotalWorldSize,
    getWorldBoundingRectangle,
    getWorlds,
    getOccupiedParcels,
    createBasicWorldIfNotExists,
    worldExists,
    getWorldNamesByCommunityId
  }
}

export function createMockedWorldsManager(
  overrides?: Partial<jest.Mocked<IWorldsManager>>
): jest.Mocked<IWorldsManager> {
  return {
    getWorldSettings: jest.fn(),
    updateWorldSettings: jest.fn(),
    getRawWorldRecords: jest.fn(),
    getDeployedWorldCount: jest.fn(),
    getMetadataForWorld: jest.fn(),
    getEntityForWorlds: jest.fn(),
    deployScene: jest.fn(),
    undeployScene: jest.fn(),
    storeAccess: jest.fn(),
    undeployWorld: jest.fn(),
    getContributableDomains: jest.fn(),
    getWorldScenes: jest.fn(),
    getTotalWorldSize: jest.fn(),
    getWorldBoundingRectangle: jest.fn(),
    createBasicWorldIfNotExists: jest.fn(),
    worldExists: jest.fn(),
    getWorldNamesByCommunityId: jest.fn(),
    ...overrides
  } as jest.Mocked<IWorldsManager>
}
