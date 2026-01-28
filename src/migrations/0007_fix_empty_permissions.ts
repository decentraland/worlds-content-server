import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

// Original permissions structure (before access was separated)
const legacyDefaultPermissions = {
  deployment: { type: 'allow-list', wallets: [] },
  access: { type: 'unrestricted' },
  streaming: { type: 'allow-list', wallets: [] }
}

export const migration: Migration = {
  id: '0007_fix_empty_permissions',
  run: async (components: Pick<MigratorComponents, 'database'>) => {
    await components.database.query(
      SQL`UPDATE worlds SET permissions = ${JSON.stringify(legacyDefaultPermissions)}::json WHERE permissions IS NULL`
    )
  }
}
