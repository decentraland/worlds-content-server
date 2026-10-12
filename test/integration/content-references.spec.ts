import { stringToUtf8Bytes } from 'eth-connect'
import { Entity, EntityType } from '@dcl/schemas'
import { PoolClient } from 'pg'
import { bufferToStream } from '@dcl/catalyst-storage'
import SQL, { SQLStatement } from 'sql-template-strings'
import { test } from '../components'
import { cleanup, makeid } from '../utils'
import { getPublishedContentKeys } from '../../src/adapters/content-references'
import { AppComponents } from '../../src/types'

test('when looking up which stored content is published', ({ components }) => {
  let published: Entity
  let undeployed: Entity
  let pendingOnly: Entity
  let thumbnailHash: string
  let unreferencedHash: string

  beforeEach(async () => {
    const { worldCreator, worldsManager, pendingScenesManager, database, storage } = components

    const created = await worldCreator.createWorldWithScene({
      files: new Map([['published.txt', stringToUtf8Bytes(makeid(50))]])
    })
    published = created.entity
    thumbnailHash = `thumbnail-${makeid(10)}`
    await storage.storeStream(thumbnailHash, bufferToStream(Buffer.from('thumbnail')))
    await worldsManager.updateWorldSettings(created.worldName, created.owner.authChain[0].payload, { thumbnailHash })

    undeployed = (
      await worldCreator.createWorldWithScene({
        files: new Map([['undeployed.txt', stringToUtf8Bytes(makeid(50))]])
      })
    ).entity
    await database.query(SQL`UPDATE world_scenes SET status = 'UNDEPLOYED' WHERE entity_id = ${undeployed.id}`)

    pendingOnly = {
      version: 'v3',
      id: `pending-${makeid(10)}`,
      type: EntityType.SCENE,
      timestamp: Date.now(),
      pointers: ['0,0'],
      content: [{ hash: `pending-content-${makeid(10)}`, file: 'pending.txt' }],
      metadata: { worldConfiguration: { name: 'pending.dcl.eth' } }
    }
    await pendingScenesManager.upsert(
      {
        entityId: pendingOnly.id,
        entity: pendingOnly,
        deployer: '0xaccount',
        worldName: 'pending.dcl.eth',
        parcels: ['0,0'],
        admittedAt: new Date(),
        resumes: false
      },
      { maxPendingPerDeployer: 10 }
    )
    unreferencedHash = `unreferenced-${makeid(10)}`
  })

  afterEach(async () => {
    await cleanup(components.storage, components.database)
  })

  describe('and the candidates mix published, evicting, pending-only and unreferenced content', () => {
    let keys: Set<string>

    beforeEach(async () => {
      keys = await getPublishedContentKeys(components.database, [
        published.content![0].hash,
        published.id,
        `${published.id}.auth`,
        thumbnailHash,
        undeployed.content![0].hash,
        pendingOnly.content![0].hash,
        pendingOnly.id,
        unreferencedHash
      ])
    })

    it('should return the content of published and evicting scenes, their entity files and world thumbnails', () => {
      expect(keys).toEqual(
        new Set([
          published.content![0].hash,
          published.id,
          `${published.id}.auth`,
          thumbnailHash,
          undeployed.content![0].hash
        ])
      )
    })
  })

  describe('and the planner cannot scan world_scenes sequentially', () => {
    let client: PoolClient
    let plan: string

    beforeEach(async () => {
      client = await components.database.getPool().connect()
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      const explaining: Pick<AppComponents['database'], 'query'> = {
        query: (async (statement: SQLStatement) => {
          const result = await client.query({ text: `EXPLAIN ${statement.text}`, values: statement.values })
          plan = result.rows.map((row) => row['QUERY PLAN']).join('\n')
          return { ...result, rows: [] }
        }) as AppComponents['database']['query']
      }
      await getPublishedContentKeys(explaining as AppComponents['database'], [published.content![0].hash])
    })

    afterEach(async () => {
      await client.query('ROLLBACK')
      client.release()
    })

    it('should look content hashes up through the content hashes index', () => {
      expect(plan).toContain('world_scenes_content_hashes_idx')
    })
  })
})
