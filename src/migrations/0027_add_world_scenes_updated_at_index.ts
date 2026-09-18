import { Migration } from '../types'

export const migration: Migration = {
  // Descriptive id on purpose: the executor tracks applied migrations by this exact string, so a
  // bare '0027' would be treated as already applied if another branch ships its own '0027' first.
  id: '0027_add_world_scenes_updated_at_index',
  run: async ({ database }) => {
    // Backs garbage collection's per-batch deployed-since re-check
    // (WHERE entity IS NOT NULL AND updated_at >= $sweepStart), which is status-agnostic so neither
    // of the existing partial indexes (status = 'DEPLOYED' without updated_at, or updated_at scoped
    // to status = 'UNDEPLOYED') can serve it — without this, every GC delete batch sequentially
    // scans world_scenes.
    await database.query(`
      CREATE INDEX IF NOT EXISTS world_scenes_updated_at_idx ON world_scenes(updated_at);
    `)
  }
}
