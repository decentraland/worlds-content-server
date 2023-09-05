import { MigrationBuilder, PgType } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('worlds', {
    name: { type: PgType.VARCHAR, notNull: true, primaryKey: true },
    deployer: { type: PgType.VARCHAR, notNull: false },
    entity_id: { type: PgType.VARCHAR, notNull: false },
    deployment_auth_chain: { type: PgType.JSON, notNull: false },
    entity: { type: PgType.JSON, notNull: false },
    acl: { type: PgType.JSON, notNull: false },
    created_at: { type: PgType.TIMESTAMP, notNull: true },
    updated_at: { type: PgType.TIMESTAMP, notNull: true }
  })

  pgm.createIndex('worlds', 'deployer')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('worlds')
}
