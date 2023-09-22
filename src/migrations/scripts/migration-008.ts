import { MigratorComponents } from '../../types'
import SQL from 'sql-template-strings'
import { defaultPermissions } from '../../logic/permissions-checker'

export default {
  run: async (components: Pick<MigratorComponents, 'logs' | 'database'>) => {
    const logger = components.logs.getLogger('migration-008')
    logger.info('running migration 008 - fix empty permissions')

    await components.database.query(
      SQL`UPDATE worlds SET permissions = ${JSON.stringify(defaultPermissions())}::json WHERE permissions IS NULL`
    )
  }
}
