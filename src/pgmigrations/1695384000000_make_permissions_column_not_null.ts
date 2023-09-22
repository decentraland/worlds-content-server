import { MigrationBuilder, PgType } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('worlds', 'permissions', {
    type: PgType.JSON,
    notNull: true
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('worlds', 'permissions', {
    type: PgType.JSON,
    notNull: false
  })
}
