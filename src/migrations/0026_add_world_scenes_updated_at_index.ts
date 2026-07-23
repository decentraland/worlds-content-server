import { Migration } from '../types'

export const migration: Migration = {
  id: '0026',
  run: async ({ database }) => {
    // Backs garbage collection's per-batch deployed-since re-check
    // (WHERE entity IS NOT NULL AND updated_at >= $sweepStart), which is status-agnostic so neither
    // of the existing partial indexes (status = 'DEPLOYED' without updated_at, or updated_at scoped
    // to status = 'UNDEPLOYED') can serve it — without this, every GC delete batch sequentially
    // scans world_scenes.
    await database.query(`
      CREATE INDEX world_scenes_updated_at_idx ON world_scenes(updated_at);
    `)
  }
}
