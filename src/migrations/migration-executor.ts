import { join } from 'path'
import * as fs from 'fs'
import { MigratorComponents } from '../types'
import { Readable } from 'stream'

export interface MigrationExecutor {
  run: () => Promise<void>
}

export function createMigrationExecutor(components: MigratorComponents): MigrationExecutor {
  const { logs, storage } = components
  const logger = logs.getLogger('migration-executor')

  const dir = join(__dirname, 'scripts')
  const regExp = /migration-[0-9]{3}\.js$/
  const scripts = fs.readdirSync(dir).filter((file) => regExp.test(file))

  async function run(): Promise<void> {
    logger.debug('Running migrations')
    for (const script of scripts) {
      const migration = (await import(join(dir, script))).default
      try {
        if (await storage.exist(script)) {
          logger.info(`migration id ${script} has run in the past`)
          continue
        }

        logger.info(`running migration ${script}`)
        await migration.run(components)
        logger.info(`migration ${script} run successfully`)

        await storage.storeStream(script, Readable.from(Buffer.from('')))
      } catch (error: any) {
        logger.error(`error running migration ${script}. Error: ${error.message}`)
        throw Error('Abort running migrations')
      }
    }
  }

  return {
    run
  }
}
