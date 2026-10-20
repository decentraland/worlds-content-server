import { Migration } from '../types'

export const migration: Migration = {
  id: '0029_pending_scene_batches',
  run: async ({ database }) => {
    // Stored batches per partial upload, reported when it is published.
    await database.query(`ALTER TABLE pending_scenes ADD COLUMN IF NOT EXISTS batches INTEGER NOT NULL DEFAULT 0;`)
  }
}
