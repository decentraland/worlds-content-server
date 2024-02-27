import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { S3 } from 'aws-sdk'
import { createAwsConfig } from '../adapters/aws-config'
import {
  createFolderBasedFileSystemContentStorage,
  createFsComponent,
  createS3BasedFileSystemContentStorage
} from '@dcl/catalyst-storage'
import { createLogComponent } from '@well-known-components/logger'
import { AppComponents, WorldRecord } from '../types'
import { createDatabaseComponent } from '../adapters/database-component'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../metrics'
import SQL from 'sql-template-strings'

function formatSecs(millis: number): string {
  return `${(millis / 1000).toFixed(2)} secs`
}

export async function garbageCollect(components: Pick<AppComponents, 'database' | 'storage'>, prefix: string = '') {
  const { storage } = components
  async function getAllBucketKeys() {
    const start = Date.now()
    console.info('Getting all keys from storage...')
    const allStoredKeys = new Set<string>()
    for await (const key of storage.allFileIds(prefix)) {
      allStoredKeys.add(key)
    }
    console.info(`Done in ${formatSecs(Date.now() - start)}. Storage contains ${allStoredKeys.size} keys.`)
    return allStoredKeys
  }

  async function getAllUsedKeys() {
    const { database } = components
    const start = Date.now()
    console.info('Getting all keys from database...')

    const allUsedKeys = new Set<string>()
    const result = await database.query<WorldRecord>(
      SQL`SELECT *
          FROM worlds
          WHERE worlds.entity IS NOT NULL`
    )
    result.rows.forEach((row) => {
      if (row.entity) {
        // Add entity file and deployment auth-chain
        allUsedKeys.add(row.entity_id)
        allUsedKeys.add(`${row.entity_id}.auth`)

        // Add all referenced content files
        for (const file of row.entity.content) {
          allUsedKeys.add(file.hash)
        }
      }
    })

    console.info(`Done in ${formatSecs(Date.now() - start)}. Database contains ${allUsedKeys.size} keys.`)

    return allUsedKeys
  }

  const allStoredKeys = await getAllBucketKeys()
  const allUsedKeys = await getAllUsedKeys()

  allUsedKeys.forEach((key) => {
    allStoredKeys.delete(key)
  })
  console.log(`Storage contains ${allStoredKeys.size} unused keys that should be removed.`)
}

async function configStorage(components: Pick<AppComponents, 'config' | 'logs'>) {
  const { config, logs } = components
  const awsConfig = await createAwsConfig({ config })
  const bucket = await config.requireString('BUCKET')
  const storageFolder = (await config.getString('STORAGE_FOLDER')) || 'contents'
  return bucket
    ? await createS3BasedFileSystemContentStorage({ logs }, new S3(awsConfig), {
        Bucket: bucket,
        getKey: (hash: string) => hash
      })
    : await createFolderBasedFileSystemContentStorage({ fs: createFsComponent(), logs }, storageFolder)
}

async function main() {
  const config = await createDotEnvConfigComponent({
    path: ['.env.default', '.env', '.env.admin']
  })
  const metrics = createTestMetricsComponent(metricDeclarations)
  const logs = await createLogComponent({ config })
  const storage = await configStorage({ config, logs })
  const database = await createDatabaseComponent({ config, logs, metrics })

  await garbageCollect({ database, storage })
}

main().catch(console.error)
