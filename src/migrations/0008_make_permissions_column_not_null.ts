import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0008_make_permissions_column_not_null',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(SQL`
        ALTER TABLE worlds
            ALTER COLUMN permissions SET NOT NULL
    `)
  }
}
