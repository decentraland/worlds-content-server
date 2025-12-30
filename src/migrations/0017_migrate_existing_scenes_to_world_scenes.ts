import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0017_migrate_existing_scenes_to_world_scenes',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0017')

    logger.info('Migrating existing single-scene worlds to world_scenes table')

    const result = await database.query<{
      name: string
      entity_id: string
      entity: any
      deployment_auth_chain: any
      deployer: string
      size: string
      created_at: Date
      updated_at: Date
    }>(`
      SELECT name, entity_id, entity, deployment_auth_chain, deployer, size, created_at, updated_at
      FROM worlds
      WHERE entity_id IS NOT NULL
    `)

    let migratedCount = 0
    for (const row of result.rows) {
      try {
        // Extract parcels from entity pointers
        const parcels = row.entity?.pointers || []

        // Extract world settings from entity metadata
        const worldConfiguration = row.entity?.metadata?.worldConfiguration || {}
        const worldSettings = {
          name: worldConfiguration.name || row.name,
          miniMapConfig: worldConfiguration.miniMapConfig,
          skyboxConfig: worldConfiguration.skyboxConfig,
          fixedAdapter: worldConfiguration.fixedAdapter
        }

        // Insert into world_scenes table
        await database.query(
          SQL`
            INSERT INTO world_scenes (
              world_name, entity_id, entity, deployment_auth_chain, 
              deployer, parcels, size, created_at, updated_at
            ) VALUES (
              ${row.name},
              ${row.entity_id},
              ${row.entity}::json,
              ${row.deployment_auth_chain}::json,
              ${row.deployer},
              ${parcels}::text[],
              ${row.size},
              ${row.created_at},
              ${row.updated_at}
            )
            ON CONFLICT (world_name, entity_id) DO NOTHING
          `
        )

        // Update world_settings in worlds table
        await database.query(
          SQL`
            UPDATE worlds
            SET world_settings = ${JSON.stringify(worldSettings)}::json,
                description = ${row.entity?.metadata?.display?.description || null},
                thumbnail_hash = ${
                  row.entity?.content?.find((c: any) => c.file === row.entity?.metadata?.display?.navmapThumbnail)
                    ?.hash || null
                }
            WHERE name = ${row.name}
          `
        )

        migratedCount++
      } catch (error: any) {
        logger.error(`Failed to migrate scene for world ${row.name}: ${error.message}`)
      }
    }

    logger.info(`Successfully migrated ${migratedCount} scenes to world_scenes table`)
  }
}

