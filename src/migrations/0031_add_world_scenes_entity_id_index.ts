import { Migration } from '../types'

export const migration: Migration = {
  id: '0031_add_world_scenes_entity_id_index',
  run: async ({ database }) => {
    // Backs the published-entity lookups of partial uploads; not partial, as reference checks ignore status.
    // CONCURRENTLY keeps deploys writing during the build; a failed build leaves an invalid index to drop first.
    const invalid = await database.query(`
      SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'world_scenes_entity_id_idx' AND NOT i.indisvalid
    `)
    if (invalid.rowCount) {
      await database.query('DROP INDEX CONCURRENTLY IF EXISTS world_scenes_entity_id_idx')
    }
    await database.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS world_scenes_entity_id_idx ON world_scenes (entity_id)'
    )
  }
}
