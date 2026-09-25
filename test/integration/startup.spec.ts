import { test } from '../components'
import { initComponents } from '../../src/components'
import { allMigrations } from '../../src/migrations/all-migrations'

test('Service startup', function ({ components }) {
  describe('when the components are started', () => {
    let startOrder: string[]
    let appliedMigrations: string[]

    beforeEach(async () => {
      const { database } = components
      // Lifecycle starts components in declaration order; this set is only built, never started.
      startOrder = Object.keys(await initComponents())
      const result = await database.query<{ name: string }>('SELECT name FROM migrations')
      appliedMigrations = result.rows.map((row) => row.name)
    })

    it('should start the database and then the migration executor before any other component', () => {
      expect(startOrder.slice(0, 2)).toEqual(['database', 'migrationExecutor'])
    })

    it('should have applied every migration', () => {
      expect(appliedMigrations).toEqual(expect.arrayContaining(allMigrations.map((migration) => migration.id)))
    })
  })
})
