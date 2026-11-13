import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Pool, PoolClient } from 'pg'
import { SQLStatement } from 'sql-template-strings'
import { AuthLinkType, Entity, EntityType } from '@dcl/schemas'
import { createWorldsManagerComponent } from '../../src/adapters/worlds-manager'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { AccessSetting } from '../../src/logic/access'
import { IWorldsManager } from '../../src/types'

type Components = Parameters<typeof createWorldsManagerComponent>[0]

function dependencies(database: unknown, captureEnabled: boolean): Components {
  // Only these collaborators are exercised by access mutation and scene transaction tests.
  return {
    config: { getString: jest.fn().mockResolvedValue(captureEnabled ? 'true' : undefined) },
    settingsPolicy: {
      toStorableTitle: () => null,
      toStorableDescription: () => null,
      isValidContentRating: () => false,
      toStorableSkyboxTime: () => null,
      toStorableCategories: () => null
    },
    coordinates: createCoordinatesComponent(),
    logs: { getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
    database,
    nameDenyListChecker: {},
    pendingScenesRepository: { recordPublication: jest.fn().mockResolvedValue({ consumed: false, live: false }) },
    search: {},
    storage: {},
    thumbnails: {}
  } as unknown as Components
}

describe.each([false, true])('when Worlds capture is enabled: %s', (captureEnabled) => {
  let manager: IWorldsManager
  let query: jest.Mock
  let release: jest.Mock
  let scene: Entity
  let abortController: AbortController

  beforeEach(async () => {
    query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    release = jest.fn()
    abortController = new AbortController()
    scene = {
      version: 'v3',
      id: 'entity-id',
      type: EntityType.SCENE,
      timestamp: 1,
      pointers: ['0,0'],
      content: [],
      metadata: { scene: { parcels: ['0,0'], base: '0,0' } }
    }
    manager = await createWorldsManagerComponent(
      dependencies(
        {
          query,
          withAsyncContextTransaction: jest.fn(async (operation: () => Promise<unknown>) => operation()),
          getPool: () => ({ connect: async () => ({ query, release }) })
        },
        captureEnabled
      )
    )
  })

  afterEach(() => jest.resetAllMocks())

  describe('and a mutation locks a world row', () => {
    beforeEach(async () => {
      await manager.modifyAccessAtomically('pilot.dcl.eth', (current: AccessSetting) => current)
    })

    it('should acquire the capture lock before the row lock only when enabled', () => {
      expect(query.mock.calls[0][0].text).toContain(captureEnabled ? 'pg_advisory_xact_lock(179321, 2)' : 'FOR UPDATE')
    })
  })

  describe('and a deployment uses a dedicated abortable transaction', () => {
    beforeEach(async () => {
      await manager.deployScene(
        'pilot.dcl.eth',
        scene,
        '0xowner',
        { mode: 'unrestricted-owner' },
        {
          authChain: [{ type: AuthLinkType.SIGNER, payload: '0xDeployer', signature: '' }],
          size: 1,
          signal: abortController.signal
        }
      )
    })

    it('should take the capture lock immediately after BEGIN only when enabled', () => {
      expect(query.mock.calls[0][0]).toBe('BEGIN')
      expect(query.mock.calls[1][0].text).toContain(
        captureEnabled ? 'pg_advisory_xact_lock(179321, 2)' : 'pg_advisory_xact_lock(hashtextextended('
      )
    })
  })
})

const databaseSuite = process.env.MIGRATION_WORLDS_TEST_DATABASE_URL ? describe : describe.skip

databaseSuite('when a captured job and a native world mutation run concurrently', () => {
  let admin: Pool
  let pool: Pool
  let databaseName: string
  let databaseUrl: URL
  let manager: IWorldsManager
  let context: AsyncLocalStorage<PoolClient>
  let job: PoolClient
  let mutation: Promise<unknown> | undefined
  let modificationCompleted: boolean
  let waitState: { wait_event: string | null }
  let attempts: number

  beforeEach(async () => {
    databaseName = `worlds_capture_${randomUUID().replace(/-/g, '')}`
    admin = new Pool({ connectionString: process.env.MIGRATION_WORLDS_TEST_DATABASE_URL })
    await admin.query(`CREATE DATABASE ${databaseName}`)
    databaseUrl = new URL(process.env.MIGRATION_WORLDS_TEST_DATABASE_URL)
    databaseUrl.pathname = `/${databaseName}`
    pool = new Pool({
      connectionString: databaseUrl.toString(),
      application_name: 'worlds-capture-regression',
      statement_timeout: 3000
    })
    await pool.query(`CREATE TABLE worlds(name text PRIMARY KEY,owner text,access jsonb,settings_version bigint DEFAULT 0,created_at timestamp,updated_at timestamp);
      INSERT INTO worlds(name,owner,access) VALUES('pilot.dcl.eth','old','{"type":"unrestricted"}');
      CREATE FUNCTION capture_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(179321,2); RETURN NULL; END $$;
      CREATE TRIGGER capture_before BEFORE INSERT OR UPDATE OR DELETE ON worlds FOR EACH STATEMENT EXECUTE FUNCTION capture_lock();`)
    context = new AsyncLocalStorage<PoolClient>()
    mutation = undefined
    modificationCompleted = false
    attempts = 0
    manager = await createWorldsManagerComponent(
      dependencies(
        {
          query: async (statement: SQLStatement) => {
            const client = context.getStore()
            if (!client) throw new Error('native transaction context missing')
            return client.query(statement)
          },
          withAsyncContextTransaction: async (operation: () => Promise<unknown>) => {
            const client = await pool.connect()
            try {
              await client.query('BEGIN')
              const result = await context.run(client, operation)
              await client.query('COMMIT')
              return result
            } catch (error) {
              await client.query('ROLLBACK')
              throw error
            } finally {
              client.release()
            }
          }
        },
        true
      )
    )
    job = await pool.connect()
    await job.query('BEGIN')
    await job.query("SET LOCAL lock_timeout='500ms'")
    await job.query('SELECT pg_advisory_xact_lock(179321,2)')
    mutation = manager.modifyAccessAtomically('pilot.dcl.eth', (current) => ({ ...current }))
    while (attempts++ < 100) {
      waitState = (
        await pool.query(
          "SELECT wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory'"
        )
      ).rows[0]
      if (waitState) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (!waitState) throw new Error('native mutation never waited on capture lock')
    // With the previous row-first order, the native transaction already owned
    // this row and this update timed out (or deadlocked). Capture-first leaves it free.
    await job.query("UPDATE worlds SET owner='new' WHERE name='pilot.dcl.eth'")
    await job.query('COMMIT')
    await mutation
    modificationCompleted = true
  })

  afterEach(async () => {
    if (job) {
      await job.query('ROLLBACK').catch(() => undefined)
      job.release()
    }
    await mutation?.catch(() => undefined)
    await pool?.end()
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
      await admin.end()
    }
    jest.resetAllMocks()
  })

  it('should complete both transactions without a lock-order cycle', () => {
    expect(modificationCompleted).toBe(true)
  })
})
