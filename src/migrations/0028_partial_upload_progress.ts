import { Migration } from '../types'

export const migration: Migration = {
  id: '0028_partial_upload_progress',
  run: async ({ database }) => {
    await database.query(`
      ALTER TABLE pending_scenes ADD COLUMN IF NOT EXISTS initialized BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE pending_scenes ADD COLUMN IF NOT EXISTS reserved_bytes BIGINT NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS pending_scene_files (
        entity_id VARCHAR NOT NULL REFERENCES pending_scenes(entity_id) ON DELETE CASCADE,
        hash VARCHAR NOT NULL,
        size BIGINT NOT NULL CHECK (size >= 0),
        stored BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (entity_id, hash)
      );
      CREATE TABLE IF NOT EXISTS completed_scene_uploads (
        entity_id VARCHAR PRIMARY KEY,
        deployer VARCHAR NOT NULL,
        world_name VARCHAR NOT NULL,
        parcels TEXT[] NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS completed_scene_uploads_completed_at_idx ON completed_scene_uploads(completed_at);
      CREATE TABLE IF NOT EXISTS partial_upload_rates (
        deployer VARCHAR PRIMARY KEY,
        window_started TIMESTAMPTZ NOT NULL,
        bytes BIGINT NOT NULL
      );
    `)
  }
}
