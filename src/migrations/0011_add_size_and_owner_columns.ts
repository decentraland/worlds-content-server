import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0011_add_size_and_owner_columns',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(SQL`
        ALTER TABLE worlds
            ADD COLUMN size  BIGINT,
            ADD COLUMN owner VARCHAR
    `)
  }
}
