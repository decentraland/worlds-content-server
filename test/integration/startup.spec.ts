import { IBaseComponent, Lifecycle, START_COMPONENT } from '@well-known-components/interfaces'
import { test } from '../components'
import { initComponents } from '../../src/components'
import { allMigrations } from '../../src/migrations/all-migrations'

test('Service startup', function ({ components }) {
  describe('when the components are started', () => {
    let startOrder: string[]
    let appliedMigrations: string[]

    beforeAll(async () => {
      // Built, never started: each component is replaced by a recorder so the real Lifecycle reports the order.
      const built = await initComponents()
      startOrder = []
      const recorders: Record<string, IBaseComponent> = Object.fromEntries(
        Object.keys(built).map((name) => [name, { [START_COMPONENT]: async () => void startOrder.push(name) }])
      )
      const program = await Lifecycle.run({
        initComponents: async () => recorders,
        main: async ({ startComponents }) => startComponents()
      })
      await program.stop()
    })

    beforeEach(async () => {
      const result = await components.database.query<{ name: string }>('SELECT name FROM migrations ORDER BY id')
      appliedMigrations = result.rows.map((row) => row.name)
    })

    it('should start the database and then the migration executor before any other component', () => {
      expect(startOrder.slice(0, 2)).toEqual(['database', 'migrationExecutor'])
    })

    it('should have applied every migration once, in order', () => {
      expect(appliedMigrations).toEqual(allMigrations.map((migration) => migration.id))
    })
  })
})
