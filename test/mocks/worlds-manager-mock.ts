import {
  AppComponents,
  ContributorDomain,
  GetWorldScenesFilters,
  GetWorldScenesOptions,
  GetWorldScenesResult,
  IPermissionChecker,
  IWorldsManager,
  Permissions,
  WorldMetadata,
  WorldRecord,
  WorldScene,
  WorldSettings,
  WorldBoundingRectangle,
  SceneOrderBy,
  OrderDirection
} from '../../src/types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { Entity, EthAddress } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'
import { buildWorldRuntimeMetadata } from '../../src/logic/world-runtime-metadata-utils'
import { createPermissionChecker, defaultPermissions } from '../../src/logic/permissions-checker'

export async function createWorldsManagerMockComponent({
  coordinates,
  storage
}: Pick<AppComponents, 'coordinates' | 'storage'>): Promise<IWorldsManager> {
  const { extractSpawnCoordinates, calculateBoundingRectangle } = coordinates

  async function getRawWorldRecords(): Promise<WorldRecord[]> {
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
          permissions: { ...defaultPermissions() },
          spawn_coordinates: spawnCoordinates,
          created_at: new Date(1706019701900),
          updated_at: new Date(1706019701900),
          blocked_since: null
        })
      }
    }
    return worlds
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

    const scenes = [...metadata.scenes]

    // Apply sorting
    const orderDirection = options?.orderDirection ?? OrderDirection.Asc

    scenes.sort((a, b) => {
      const aValue = a.createdAt.getTime()
      const bValue = b.createdAt.getTime()
      return orderDirection === OrderDirection.Asc ? aValue - bValue : bValue - aValue
    })

    const limit = options?.limit || scenes.length
    const offset = options?.offset || 0

    return {
      scenes: scenes.slice(offset, offset + limit),
      total: metadata.scenes.length
    }
  }

  async function updateWorldSettings(_worldName: string, _settings: WorldSettings): Promise<void> {
    // Mock implementation - no-op
  }

  async function getWorldSettings(_worldName: string): Promise<WorldSettings | undefined> {
    return undefined
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

  async function storePermissions(worldName: string, permissions: Permissions): Promise<void> {
    await storeWorldMetadata(worldName, { permissions })
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

  async function permissionCheckerForWorld(worldName: string): Promise<IPermissionChecker> {
    const metadata = await getMetadataForWorld(worldName)
    return createPermissionChecker(metadata?.permissions || defaultPermissions())
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

  async function getContributableDomains(address: string): Promise<{ domains: ContributorDomain[]; count: number }> {
    const domains: ContributorDomain[] = []
    for await (const name of storage.allFileIds('name-')) {
      const metadata = await getMetadataForWorld(name)
      const entity = await getEntityForWorld(name)
      if (entity) {
        const content = await storage.retrieve(`${entity.id}.auth`)
        const authChain = JSON.parse((await streamToBuffer(await content?.asStream())).toString())
        const hasDeploymentPermission = metadata.permissions.deployment.wallets.includes(address)
        const hasStreamingPermission =
          'wallets' in metadata.permissions.streaming && metadata.permissions.streaming.wallets.includes(address)
        if (hasStreamingPermission || hasStreamingPermission) {
          domains.push({
            name,
            user_permissions: [
              ...(hasDeploymentPermission ? ['deployment'] : []),
              ...(hasStreamingPermission ? ['streaming'] : [])
            ],
            size: '0',
            owner: authChain[0].payload
          })
        }
      }
    }
    return { domains, count: domains.length }
  }

  return {
    getContributableDomains,
    getRawWorldRecords,
    getDeployedWorldCount,
    getMetadataForWorld,
    getEntityForWorlds,
    deployScene,
    undeployScene,
    storePermissions,
    permissionCheckerForWorld,
    undeployWorld,
    getWorldScenes,
    updateWorldSettings,
    getWorldSettings,
    getTotalWorldSize,
    getWorldBoundingRectangle
  }
}
