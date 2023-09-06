import { MigratorComponents, WorldMetadata } from '../../types'
import { streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import SQL from 'sql-template-strings'

export default {
  run: async (components: Pick<MigratorComponents, 'logs' | 'database' | 'storage'>) => {
    const { logs, database, storage } = components
    const logger = logs.getLogger('migration-003')
    logger.info('running migration 003 - migration of worlds to database')

    async function readFile(key: string): Promise<WorldMetadata | undefined> {
      const content = await storage.retrieve(key)
      if (!content) {
        return undefined
      }
      return JSON.parse((await streamToBuffer(await content.asStream())).toString()) as WorldMetadata
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
          sceneString = (await readFileAsString(existing.entityId)) as any
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
