import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

export const migration: Migration = {
  id: '0012_store_world_owner_and_size',
  run: async (components: Pick<MigratorComponents, 'database' | 'nameOwnership' | 'storage' | 'worldsManager'>) => {
    const worlds = await components.database.query(
      'SELECT name, entity FROM worlds WHERE entity IS NOT NULL ORDER BY name'
    )
    for (const world of worlds.rows) {
      const worldName = world.name
      const scene = world.entity

      const owner = (await components.nameOwnership.findOwners([worldName])).get(worldName)
      const fileInfos = await components.storage.fileInfoMultiple(
        scene.content?.map((c: ContentMapping) => c.hash) || []
      )
      const size =
        scene.content?.reduce((acc: number, c: ContentMapping) => acc + (fileInfos.get(c.hash)?.size || 0), 0) || 0

      await components.database.query(SQL`
            UPDATE worlds
            SET owner = ${owner}, size = ${size}
            WHERE name = ${worldName}`)
    }
  }
}
