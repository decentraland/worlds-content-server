import { MigrationBuilder, PgType } from 'node-pg-migrate'

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('worlds', {
    permissions: { type: PgType.JSON, notNull: false }
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('worlds', ['permissions'])
}
