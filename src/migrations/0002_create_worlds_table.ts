import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0002_create_worlds_table',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(SQL`
        CREATE TABLE worlds
        (
            name VARCHAR NOT NULL PRIMARY KEY,
            deployer VARCHAR,
            entity_id VARCHAR,
            deployment_auth_chain JSON,
            entity JSON,
            acl JSON,
            created_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL
        );

        CREATE INDEX worlds_deployer_index ON worlds (deployer);
    `)
  }
}
