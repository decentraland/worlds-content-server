import { MigrationBuilder, PgType } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('blocked', {
    wallet: { type: PgType.VARCHAR, notNull: false, primaryKey: true },
    created_at: { type: PgType.TIMESTAMP, notNull: true },
    updated_at: { type: PgType.TIMESTAMP, notNull: true }
  })

  pgm.createIndex('blocked', 'wallet')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('blocked')
}
