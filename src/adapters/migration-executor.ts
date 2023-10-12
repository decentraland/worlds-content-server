import { join } from 'path'
import * as fs from 'fs'
import { MigratorComponents } from '../types'
import { IBaseComponent } from '@well-known-components/interfaces/dist/components/base-component'
import SQL from 'sql-template-strings'

export interface MigrationExecutor {
  run: () => Promise<void>
}

export function createMigrationExecutor(components: MigratorComponents): MigrationExecutor & IBaseComponent {
  const { logs, storage } = components
  const logger = logs.getLogger('migration-executor')

  const dir = join(__dirname, '../migrations')
  console.log('dir', dir)
  const regExp = /[0-9]*_[a-zA-Z0-9_]*\.js$/
  const scripts = fs.readdirSync(dir).filter((file) => regExp.test(file))

  const alreadyRunMigrations: string[] = []
  const existingCodeMigrations: string[] = []
  const pendingMigrations: string[] = []

  async function start(): Promise<void> {
    const result = await components.database.query<{ name: string; run_on: Date }>(
      'SELECT name, run_on from migrations'
    )
    alreadyRunMigrations.push(...result.rows.map((row) => row.name))
    existingCodeMigrations.push(...scripts.map((script) => script.slice(0, -3)))
    pendingMigrations.push(...existingCodeMigrations.filter((script) => !alreadyRunMigrations.includes(script)))

    // TODO Run startup checks, like:
    // 1. Check the migration table exists and if not, create it.
    // 2. Check all existing migrations are known in code.
    // 3. Check all code migration and existing migrations are order correctly time.
    console.log('alreadyRunMigrations', alreadyRunMigrations)
    console.log('existingCodeMigrations', existingCodeMigrations)
    console.log('pendingMigrations', pendingMigrations)
  }

  async function runMigration(script: string, migration: any) {
    logger.info(`running migration ${script}`)
    await migration.run(components)
    await components.database.query(SQL`INSERT INTO migrations (name, run_on) VALUES (${script}, ${new Date()})`)
    logger.info(`migration ${script} run successfully`)
  }

  async function run(): Promise<void> {
    logger.debug('Running migrations')
    for (const script of pendingMigrations) {
      const migration = (await import(join(dir, `${script}.js`))).default
      await runMigration(script, migration)
      logger.info(`running migration ${script}: ${migration}`)
      try {
        if (await storage.exist(script)) {
          logger.info(`migration id ${script} has run in the past`)
          continue
        }

        logger.info(`running migration ${script}`)
      } catch (error: any) {
        logger.error(`error running migration ${script}. Error: ${error.message}`)
        throw Error('Abort running migrations')
      }
    }
  }

  return {
    start,
    run
  }
}
