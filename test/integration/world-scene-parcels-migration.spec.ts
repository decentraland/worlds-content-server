import SQL from 'sql-template-strings'
import { migration } from '../../src/migrations/0025_normalize_world_scene_parcels'
import { test } from '../components'

test('WorldSceneParcelsMigration', function ({ components }) {
  describe('when a stored world scene contains legacy parcel coordinates', () => {
    let worldName: string

    beforeEach(async () => {
      const { database, worldCreator } = components
      worldName = worldCreator.randomWorldName()
      await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '1,1', parcels: ['1,1', '2,1', '3,1'] },
          worldConfiguration: { name: worldName }
        }
      })

      await database.query(
        SQL`UPDATE world_scenes
            SET parcels = ${[' 01,01 ', '02,01', '2,1', 'not-a-coordinate', 'not-a-coordinate']}
            WHERE world_name = ${worldName}`
      )

      await migration.run(components)
    })

    afterEach(async () => {
      await components.database.query(SQL`DELETE FROM world_scenes WHERE world_name = ${worldName}`)
      await components.database.query(SQL`DELETE FROM worlds WHERE name = ${worldName}`)
      jest.resetAllMocks()
    })

    it('should canonicalize and deduplicate parcels in first-occurrence order', async () => {
      const { scenes } = await components.worldsManager.getWorldScenes({ worldName })

      expect(scenes[0].parcels).toEqual(['1,1', '2,1', 'not-a-coordinate'])
    })
  })

  describe('when deployed scenes collapse onto the same canonical parcel', () => {
    let expectedCollision: string
    let firstEntityId: string
    let migrationError: unknown
    let secondEntityId: string
    let storedParcelsByEntity: Record<string, string[]>
    let worldName: string

    beforeEach(async () => {
      const { database, worldCreator } = components
      worldName = worldCreator.randomWorldName()
      migrationError = undefined
      const firstScene = await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '1,1', parcels: ['1,1'] },
          worldConfiguration: { name: worldName }
        }
      })
      const secondScene = await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '2,2', parcels: ['2,2'] },
          worldConfiguration: { name: worldName }
        }
      })
      firstEntityId = firstScene.entityId
      secondEntityId = secondScene.entityId
      expectedCollision = `${worldName}:1,1 (${[firstEntityId, secondEntityId].sort().join(', ')})`

      await database.query(
        SQL`UPDATE world_scenes
            SET parcels = CASE
              WHEN entity_id = ${firstEntityId} THEN ${['01,01']}::text[]
              ELSE ${['1,1']}::text[]
            END
            WHERE entity_id = ANY(${[firstEntityId, secondEntityId]}::text[])`
      )

      try {
        await migration.run(components)
      } catch (error) {
        migrationError = error
      }

      const storedScenes = await database.query<{ entity_id: string; parcels: string[] }>(
        SQL`SELECT entity_id, parcels
            FROM world_scenes
            WHERE entity_id = ANY(${[firstEntityId, secondEntityId]}::text[])`
      )
      storedParcelsByEntity = Object.fromEntries(storedScenes.rows.map((scene) => [scene.entity_id, scene.parcels]))
    })

    afterEach(async () => {
      await components.database.query(SQL`DELETE FROM world_scenes WHERE world_name = ${worldName}`)
      await components.database.query(SQL`DELETE FROM worlds WHERE name = ${worldName}`)
      jest.resetAllMocks()
    })

    it('should reject the migration with the conflicting world, parcel, and scene identities', () => {
      expect(migrationError).toEqual(
        expect.objectContaining({
          name: 'WorldSceneParcelCollisionError',
          message: expect.stringContaining(expectedCollision)
        })
      )
    })

    it('should leave every conflicting row unchanged', () => {
      expect(storedParcelsByEntity).toEqual({
        [firstEntityId]: ['01,01'],
        [secondEntityId]: ['1,1']
      })
    })
  })
})
