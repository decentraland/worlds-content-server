import { MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export default {
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(SQL`
        ALTER TABLE worlds
            ALTER COLUMN permissions SET NOT NULL
    `)
  }
}
