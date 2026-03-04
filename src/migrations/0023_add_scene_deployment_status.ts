import { Migration } from '../types'

export const migration: Migration = {
  id: '0023',
  run: async ({ database }) => {
    await database.query(`
      ALTER TABLE world_scenes ADD COLUMN status VARCHAR NOT NULL DEFAULT 'DEPLOYED';
      ALTER TABLE world_scenes ADD COLUMN updated_at TIMESTAMP;
      UPDATE world_scenes SET updated_at = created_at;
      ALTER TABLE world_scenes ALTER COLUMN updated_at SET NOT NULL;

      -- Partial index for hot path (most queries want only DEPLOYED)
      CREATE INDEX world_scenes_status_idx ON world_scenes(status) WHERE status = 'DEPLOYED';
      -- Partial index for eviction job (find old UNDEPLOYED records)
      CREATE INDEX world_scenes_undeployed_updated_at_idx ON world_scenes(updated_at) WHERE status = 'UNDEPLOYED';
    `)
  }
}
