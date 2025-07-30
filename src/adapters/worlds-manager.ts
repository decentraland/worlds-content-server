import {
  AppComponents,
  IPermissionChecker,
  IWorldsManager,
  Permissions,
  WorldMetadata,
  WorldRecord,
  ContributorDomain
} from '../types'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { Entity, EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { extractWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'
import { createPermissionChecker, defaultPermissions } from '../logic/permissions-checker'

export async function createWorldsManagerComponent({
  logs,
  database,
  nameDenyListChecker,
  storage
}: Pick<AppComponents, 'logs' | 'database' | 'nameDenyListChecker' | 'storage'>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')

  async function getRawWorldRecords(): Promise<WorldRecord[]> {
    const result = await database.query<WorldRecord>(
      SQL`SELECT worlds.*, blocked.created_at AS blocked_since
              FROM worlds
              LEFT JOIN blocked ON worlds.owner = blocked.wallet`
    )

    const filtered: WorldRecord[] = []
    for (const row of result.rows) {
      if (await nameDenyListChecker.checkNameDenyList(row.name)) {
        filtered.push(row)
      }
    }

    return filtered
  }

  async function getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined> {
    if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
      logger.warn(`Attempt to access world ${worldName} which is banned.`)
      return undefined
    }

    const result = await database.query<WorldRecord>(
      SQL`SELECT worlds.*, blocked.created_at AS blocked_since
              FROM worlds
              LEFT JOIN blocked ON worlds.owner = blocked.wallet
              WHERE worlds.name = ${worldName.toLowerCase()}`
    )

    if (result.rowCount === 0) {
      return undefined
    }

    const row = result.rows[0]
    const tempWorldMetadata: Partial<WorldMetadata> = {}
    if (row.entity) {
      tempWorldMetadata.entityId = row.entity_id
      tempWorldMetadata.runtimeMetadata = extractWorldRuntimeMetadata(worldName, { ...row.entity, id: row.entity_id })
    }
    if (row.permissions) {
      tempWorldMetadata.permissions = row.permissions
    }
    if (row.blocked_since) {
      tempWorldMetadata.blockedSince = row.blocked_since
    }
    if (row.owner) {
      tempWorldMetadata.owner = row.owner
    }

    return {
      ...JSON.parse(JSON.stringify(tempWorldMetadata)),
      // this field is treated separately so that it does not get serialized to string
      blockedSince: tempWorldMetadata.blockedSince ? new Date(tempWorldMetadata.blockedSince) : undefined
    } as WorldMetadata
  }

  async function deployScene(worldName: string, scene: Entity, owner: EthAddress): Promise<void> {
    const content = await storage.retrieve(`${scene.id}.auth`)
    const deploymentAuthChainString = content ? (await streamToBuffer(await content!.asStream())).toString() : '{}'
    const deploymentAuthChain = JSON.parse(deploymentAuthChainString)

    const deployer = deploymentAuthChain[0].payload.toLowerCase()

    const fileInfos = await storage.fileInfoMultiple(scene.content?.map((c) => c.hash) || [])
    const size = scene.content?.reduce((acc, c) => acc + (fileInfos.get(c.hash)?.size || 0), 0) || 0

    const sql = SQL`
              INSERT INTO worlds (name, entity_id, owner, deployer, deployment_auth_chain, entity, permissions, size, created_at, updated_at)
              VALUES (${worldName.toLowerCase()}, ${scene.id},
                      ${owner?.toLowerCase()}, ${deployer}, ${deploymentAuthChainString}::json,
                      ${scene}::json,
                      ${JSON.stringify(defaultPermissions())}::json,
                      ${size},
                      ${new Date()}, ${new Date()})
              ON CONFLICT (name) 
                  DO UPDATE SET entity_id = ${scene.id}, 
                                owner = ${owner?.toLowerCase()},
                                deployer = ${deployer},
                                entity = ${scene}::json,
                                size = ${size},
                                deployment_auth_chain = ${deploymentAuthChainString}::json,
                                updated_at = ${new Date()}
    `
    await database.query(sql)
  }

  async function storePermissions(worldName: string, permissions: Permissions): Promise<void> {
    const sql = SQL`
              INSERT INTO worlds (name, permissions, created_at, updated_at)
              VALUES (${worldName.toLowerCase()}, ${JSON.stringify(permissions)}::json,
                      ${new Date()}, ${new Date()})
              ON CONFLICT (name) 
                  DO UPDATE SET permissions = ${JSON.stringify(permissions)}::json,
                                updated_at = ${new Date()}
    `
    await database.query(sql)
  }

  async function getDeployedWorldCount(): Promise<{ ens: number; dcl: number }> {
    const result = await database.query<{ name: string }>('SELECT name FROM worlds WHERE entity_id IS NOT NULL')
    return result.rows.reduce(
      (acc, row) => {
        if (row.name.endsWith('.dcl.eth')) {
          acc.dcl++
        } else {
          acc.ens++
        }
        return acc
      },
      { ens: 0, dcl: 0 }
    )
  }

  const mapEntity = (row: Pick<WorldRecord, 'entity_id' | 'entity' | 'owner'>) => ({
    ...row.entity,
    id: row.entity_id,
    entity: {
      ...row.entity,
      metadata: {
        ...row.entity.metadata,
        owner: row.owner
      }
    }
  })

  async function getDeployedWorldEntities(): Promise<Entity[]> {
    const result = await database.query<Pick<WorldRecord, 'name' | 'entity_id' | 'entity' | 'owner'>>(
      'SELECT name, entity_id, entity, owner FROM worlds WHERE entity_id IS NOT NULL ORDER BY name'
    )

    const filtered: Pick<WorldRecord, 'name' | 'entity_id' | 'entity' | 'owner'>[] = []
    for (const row of result.rows) {
      if (await nameDenyListChecker.checkNameDenyList(row.name)) {
        filtered.push(row)
      }
    }

    return filtered.map(mapEntity)
  }

  async function getEntityForWorld(worldName: string): Promise<Entity | undefined> {
    if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
      logger.warn(`Attempt to access entity for world ${worldName} which is banned.`)
      return undefined
    }

    const result = await database.query<Pick<WorldRecord, 'entity_id' | 'entity' | 'owner'>>(
      SQL`SELECT entity_id, entity, owner FROM worlds WHERE name = ${worldName.toLowerCase()} AND entity_id IS NOT NULL ORDER BY name`
    )

    if (result.rowCount === 0) {
      return undefined
    }

    return mapEntity(result.rows[0])
  }

  async function permissionCheckerForWorld(worldName: string): Promise<IPermissionChecker> {
    const metadata = await getMetadataForWorld(worldName)
    return createPermissionChecker(metadata?.permissions || defaultPermissions())
  }

  async function undeploy(worldName: string): Promise<void> {
    const sql = SQL`
             UPDATE worlds
             SET entity_id = null, 
                 owner = null,
                 deployer = null,
                 entity = null,
                 size = null,
                 deployment_auth_chain = null,
                 updated_at = ${new Date()}
              WHERE name = ${worldName.toLowerCase()}
    `
    await database.query(sql)
  }

  async function getContributableDomains(address: string): Promise<{ domains: ContributorDomain[]; count: number }> {
    const result = await database.query<ContributorDomain>(SQL`
      SELECT DISTINCT name, array_agg(permission) as user_permissions, size, owner
      FROM (
        SELECT *
        FROM worlds w, json_each_text(w.permissions) AS perm(permission, permissionValue)
        WHERE permission = ANY(ARRAY['deployment', 'streaming'])
      ) AS wp
      WHERE EXISTS (
        SELECT 1 FROM json_array_elements_text(wp.permissionValue::json -> 'wallets') as wallet WHERE LOWER(wallet) = LOWER(${address})
      )
      GROUP BY name, size, owner
    `)

    return {
      domains: result.rows,
      count: result.rowCount
    }
  }

  return {
    getRawWorldRecords,
    getDeployedWorldCount,
    getDeployedWorldEntities,
    getMetadataForWorld,
    getEntityForWorld,
    deployScene,
    storePermissions,
    permissionCheckerForWorld,
    undeploy,
    getContributableDomains
  }
}
