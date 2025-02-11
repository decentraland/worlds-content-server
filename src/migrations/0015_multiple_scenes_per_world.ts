import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0014_multiple_scenes_per_world',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(SQL`
        CREATE TABLE scenes
        (
            world_name VARCHAR NOT NULL REFERENCES worlds(name),
            entity_id VARCHAR NOT NULL,
            deployer VARCHAR,
            deployment_auth_chain JSON,
            entity JSON NOT NULL,
            size BIGINT NOT NULL,
            created_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL,
            PRIMARY KEY (world_name, entity_id)
        );

        CREATE INDEX scenes_world_name_index ON scenes (world_name);

        INSERT INTO scenes (world_name, entity_id, deployer, deployment_auth_chain, entity, size, created_at, updated_at)
            (SELECT name, entity_id, deployer, deployment_auth_chain, entity, size, created_at, updated_at FROM worlds WHERE entity_id IS NOT NULL);

        ALTER TABLE worlds
            DROP COLUMN entity_id,
            DROP COLUMN deployer,
            DROP COLUMN deployment_auth_chain,
            DROP COLUMN entity,
            DROP COLUMN size;
    `)
  }
}
