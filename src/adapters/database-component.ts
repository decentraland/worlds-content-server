import { createPgComponent, IPgComponent } from '@well-known-components/pg-component'
import path from 'path'

export async function createDatabaseComponent(components: createPgComponent.NeededComponents): Promise<IPgComponent> {
  const databaseUrl = await components.config.getString('PG_COMPONENT_PSQL_CONNECTION_STRING')
  if (!databaseUrl) {
    throw new Error('Env var PG_COMPONENT_PSQL_CONNECTION_STRING is required. Set it up to point to a database.')
  }

  return await createPgComponent(components, {
    migration: {
      dir: path.resolve(__dirname, '../pgmigrations'),
      migrationsTable: 'migrations',
      direction: 'up',
      databaseUrl,
      ignorePattern: '.*\\.map' // avoid sourcemaps
    }
  })
}
