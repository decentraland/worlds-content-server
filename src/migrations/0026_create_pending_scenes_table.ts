import { Migration } from '../types'

export const migration: Migration = {
  // Descriptive id on purpose: the executor tracks applied migrations by this exact string, so a
  // bare '0026' would be treated as already applied if another branch ships its own '0026' first.
  id: '0026_create_pending_scenes_table',
  run: async ({ database }) => {
    // Staging area for partial (multi-request) deployments. Intentionally NO foreign key to `worlds`:
    // a half-uploaded world must not create a `worlds` row (which would leak into listings and world
    // validity checks) before it goes live. The authoritative entity bytes live in content storage.
    await database.query(`
      CREATE TABLE IF NOT EXISTS pending_scenes (
        entity_id  VARCHAR PRIMARY KEY,
        world_name VARCHAR NOT NULL,
        parcels    TEXT[]  NOT NULL,
        entity     JSONB   NOT NULL,
        deployer   VARCHAR NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Backs expiry sweeps and the live-upload snapshot (WHERE created_at </>= $).
      CREATE INDEX IF NOT EXISTS pending_scenes_created_at_idx ON pending_scenes(created_at);
      -- Backs the per-deployer upload count cap (WHERE deployer = $).
      CREATE INDEX IF NOT EXISTS pending_scenes_deployer_created_at_idx ON pending_scenes(deployer, created_at);
      -- No index on world_name or parcels on purpose: uploads are keyed by entity id and never
      -- looked up or replaced by overlap, so those would only add write cost to every staging insert.
    `)
  }
}
