import { Migration, MigratorComponents } from '../types'
import { streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import SQL from 'sql-template-strings'
import { migrateConfiguration } from '../logic/world-runtime-metadata-utils'

const id = '0004_migrate_from_files_to_database'

export const migration: Migration = {
  id,
  run: async (components: Pick<MigratorComponents, 'logs' | 'database' | 'storage'>) => {
    const { logs, database, storage } = components
    const logger = logs.getLogger(`migration-${id}`)

    async function readFile(key: string): Promise<any | undefined> {
      const content = await storage.retrieve(key)
      if (!content) {
        return undefined
      }
      return JSON.parse((await streamToBuffer(await content.asStream())).toString())
    }

    async function readFileAsString(key: string): Promise<string | undefined> {
      const content = await storage.retrieve(key)
      if (!content) {
        return undefined
      }
      return (await streamToBuffer(await content.asStream())).toString()
    }

    // Migrate worlds to a database
    for await (const key of storage.allFileIds('name-')) {
      if (key.startsWith('name-')) {
        const worldName = key.replace('name-', '')
        const existing = await readFile(key)
        if (!existing) {
          throw new Error(`World ${worldName} not found`)
        }

        let sceneString = undefined
        let deploymentAuthChainString = undefined
        let deployer = undefined

        if (existing.entityId) {
          sceneString = await readFileAsString(existing.entityId)
          if (sceneString) {
            const entity = JSON.parse(sceneString)
            const migrated = {
              ...entity,
              metadata: {
                ...entity.metadata,
                worldConfiguration: migrateConfiguration(worldName, entity.metadata.worldConfiguration)
              }
            }
            sceneString = JSON.stringify(migrated)
          }
          deploymentAuthChainString = await readFileAsString(existing.entityId + '.auth')
          if (!deploymentAuthChainString) {
            throw new Error(`World ${worldName} has a deployment but no auth chain`)
          }

          deployer = JSON.parse(deploymentAuthChainString!)[0].payload.toLowerCase()
        }

        logger.info(`Migrating world ${worldName} to database`)

        const sql = SQL`
              INSERT INTO worlds (name, deployer, entity_id, deployment_auth_chain, entity, acl, created_at, updated_at)
              VALUES (${worldName}, ${deployer}, ${existing.entityId},
                      ${deploymentAuthChainString}::json,
                      ${sceneString}::json,
                      ${existing.acl ? JSON.stringify(existing.acl) : null}::json,
                      ${new Date()}, ${new Date()})`
        await database.query(sql)
      }
    }
    logger.info(`Finished migrating worlds to database.`)
  }
}
