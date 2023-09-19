import { MigrationBuilder, PgType } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('worlds', {
    size: { type: PgType.BIGINT, notNull: false },
    owner: { type: PgType.VARCHAR, notNull: false }
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('worlds', ['size', 'owner'])
}
