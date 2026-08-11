import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0025_add_permission_granting_owner',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0025')

    logger.info('Adding granted_under_owner column to world_permissions')

    // The migration record is only written once `run` returns, so a crash midway has to be safe to
    // replay: the column is added conditionally and the backfill only fills rows that are still
    // unset, leaving any provenance already recorded untouched.
    await database.query(`
      ALTER TABLE world_permissions ADD COLUMN IF NOT EXISTS granted_under_owner VARCHAR;
    `)

    // Backfill with the owner currently stored for the world. Existing rows have no recorded
    // provenance, and assuming they were granted by the current owner is the only assumption that
    // does not revoke everybody's permissions the first time a name changes hands after this
    // deploy. Rows whose world has no known owner stay NULL: they are treated as unknown
    // provenance and cleaned up on the next ownership change.
    const result = await database.query(`
      UPDATE world_permissions wp
      SET granted_under_owner = LOWER(w.owner)
      FROM worlds w
      WHERE w.name = wp.world_name
        AND w.owner IS NOT NULL
        AND wp.granted_under_owner IS NULL;
    `)

    logger.info(`Backfilled granted_under_owner for ${result.rowCount} permission rows`)
  }
}
