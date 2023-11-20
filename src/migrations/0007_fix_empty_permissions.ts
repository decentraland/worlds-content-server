import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'
import { defaultPermissions } from '../logic/permissions-checker'

export const migration: Migration = {
  id: '0007_fix_empty_permissions',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(
      SQL`UPDATE worlds SET permissions = ${JSON.stringify(defaultPermissions())}::json WHERE permissions IS NULL`
    )
  }
}
