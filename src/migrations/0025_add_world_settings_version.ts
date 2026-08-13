import { Migration } from '../types'

export const migration: Migration = {
  // Descriptive id on purpose: the executor tracks applied migrations by this exact string, so a
  // bare '0025' would be treated as already applied if another branch ships its own '0025' first.
  id: '0025_add_world_settings_version',
  run: async ({ database }) => {
    // Monotonic per-world settings version. Every writer of the worlds row holds the row lock,
    // so incrementing under that lock orders settings writes by commit order — unlike updated_at,
    // which is written from both the app clock and NOW() (transaction start, not commit).
    // Consumers that mirror settings use it to reject out-of-order updates.
    await database.query(`
      ALTER TABLE worlds ADD COLUMN settings_version BIGINT NOT NULL DEFAULT 0;
    `)
  }
}
