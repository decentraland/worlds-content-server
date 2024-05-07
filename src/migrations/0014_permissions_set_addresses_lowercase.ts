import { Migration, MigratorComponents, PermissionType } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0014_permissions_set_addresses_lowercase',
  run: async (components: Pick<MigratorComponents, 'database' | 'nameOwnership' | 'storage' | 'worldsManager'>) => {
    const worlds = await components.database.query('SELECT name, permissions FROM worlds ORDER BY name')

    for (const world of worlds.rows) {
      const permissions = world.permissions
      for (const permissionType of Object.keys(permissions)) {
        const permission = permissions[permissionType]
        if (permission.type === PermissionType.AllowList) {
          permission.wallets = permission.wallets.map((address: string) => address.toLowerCase())
        }
      }

      await components.database.query(SQL`
          UPDATE worlds
          SET permissions = ${JSON.stringify(permissions)}::json
          WHERE name = ${world.name}`)
    }
  }
}
