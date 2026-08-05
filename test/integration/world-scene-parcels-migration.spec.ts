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
            SET parcels = ${[' 01,01 ', '02,01', '2,1']}
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

      expect(scenes[0].parcels).toEqual(['1,1', '2,1'])
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
          name: 'WorldSceneParcelIntegrityError',
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

  describe('when a deployed scene contains an invalid parcel', () => {
    let entityId: string
    let expectedInvalidParcel: string
    let migrationError: unknown
    let storedParcels: string[]
    let worldName: string

    beforeEach(async () => {
      const { database, worldCreator } = components
      worldName = worldCreator.randomWorldName()
      migrationError = undefined
      const scene = await worldCreator.createWorldWithScene({ worldName })
      entityId = scene.entityId
      expectedInvalidParcel = `${worldName}:${entityId} ("not-a-coordinate")`

      await database.query(
        SQL`UPDATE world_scenes SET parcels = ${['01,01', 'not-a-coordinate']} WHERE entity_id = ${entityId}`
      )

      try {
        await migration.run(components)
      } catch (error) {
        migrationError = error
      }

      const storedScene = await database.query<{ parcels: string[] }>(
        SQL`SELECT parcels FROM world_scenes WHERE entity_id = ${entityId}`
      )
      storedParcels = storedScene.rows[0]?.parcels ?? []
    })

    afterEach(async () => {
      await components.database.query(SQL`DELETE FROM world_scenes WHERE world_name = ${worldName}`)
      await components.database.query(SQL`DELETE FROM worlds WHERE name = ${worldName}`)
      jest.resetAllMocks()
    })

    it('should reject the migration with the invalid parcel and scene identity', () => {
      expect(migrationError).toEqual(
        expect.objectContaining({
          name: 'WorldSceneParcelIntegrityError',
          message: expect.stringContaining(expectedInvalidParcel)
        })
      )
    })

    it('should leave the invalid scene unchanged', () => {
      expect(storedParcels).toEqual(['01,01', 'not-a-coordinate'])
    })
  })
})
