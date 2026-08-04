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
            SET parcels = ${[' 01,01 ', '02,01', 'not-a-coordinate']}
            WHERE world_name = ${worldName}`
      )

      await migration.run(components)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should canonicalize coordinates while preserving their order and malformed values', async () => {
      const { scenes } = await components.worldsManager.getWorldScenes({ worldName })

      expect(scenes[0].parcels).toEqual(['1,1', '2,1', 'not-a-coordinate'])
    })
  })
})
