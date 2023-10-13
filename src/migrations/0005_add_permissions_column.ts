import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0005_add_permissions_column',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(SQL`
        ALTER TABLE worlds
        ADD COLUMN permissions JSON ;
    `)
  }
}
