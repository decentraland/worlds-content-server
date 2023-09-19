import { MigratorComponents } from '../../types'
import SQL from 'sql-template-strings'

export default {
  run: async (
    components: Pick<MigratorComponents, 'logs' | 'database' | 'nameOwnership' | 'storage' | 'worldsManager'>
  ) => {
    const logger = components.logs.getLogger('migration-007')
    logger.info('running migration 007 - store world owner and size')

    const worlds = await components.database.query(
      'SELECT name, entity FROM worlds WHERE entity IS NOT NULL ORDER BY name'
    )
    for (const world of worlds.rows) {
      const worldName = world.name

      const owner = await components.nameOwnership.findOwner(worldName)
      await components.database.query(SQL`UPDATE worlds SET owner = ${owner} WHERE name = ${worldName}`)
    }
  }
}
