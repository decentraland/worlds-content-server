import { createPgComponent, IPgComponent } from '@well-known-components/pg-component'
import path from 'path'

export async function createDatabase(components: createPgComponent.NeededComponents): Promise<IPgComponent> {
  return await createPgComponent(components, {
    migration: {
      dir: path.resolve(__dirname, '../pgmigrations'),
      migrationsTable: 'migrations',
      direction: 'up',
      databaseUrl: await components.config.requireString('PG_COMPONENT_PSQL_CONNECTION_STRING'),
      ignorePattern: '.*\\.map' // avoid sourcemaps
    }
  })
}
