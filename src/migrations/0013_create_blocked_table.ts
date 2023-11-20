import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0013_create_blocked_table',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(SQL`
        CREATE TABLE blocked
        (
            wallet VARCHAR NOT NULL PRIMARY KEY,
            created_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL
        );

        CREATE INDEX blocked_wallet_index ON blocked (wallet);
    `)
  }
}
