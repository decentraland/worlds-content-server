import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0009_drop_acl_column',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(SQL`
        ALTER TABLE worlds
        DROP COLUMN acl;
    `)
  }
}
