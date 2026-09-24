import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { test } from '../components'
import { createContentLocks } from '../../src/adapters/content-locks/component'
import { IContentLocks } from '../../src/adapters/content-locks/types'

test('when requests wait for a busy entity lock', ({ components }) => {
  let locks: IContentLocks
  let releaseHolder: () => void
  let holder: Promise<string>
  let waiter: Promise<string>
  let otherEntity: string

  beforeEach(async () => {
    // Two connections: one held by the busy entity, one that must stay free while others wait on it.
    locks = await createContentLocks({
      config: {
        ...components.config,
        getNumber: async (key: string) => (key === 'CONTENT_LOCK_CONNECTIONS' ? 2 : components.config.getNumber(key))
      },
      logs: components.logs,
      metrics: components.metrics
    })
    await locks[START_COMPONENT]?.({} as any)
    const held = new Promise<void>((resolve) => (releaseHolder = resolve))
    holder = locks.withRead(
      async () => {
        await held
        return 'holder'
      },
      undefined,
      'busy-entity'
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    waiter = locks.withRead(async () => 'waiter', undefined, 'busy-entity')
    await new Promise((resolve) => setTimeout(resolve, 100))
    otherEntity = await Promise.race([
      locks.withRead(async () => 'other entity', undefined, 'free-entity'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 3000))
    ])
    releaseHolder()
  })

  afterEach(async () => {
    await Promise.allSettled([holder, waiter])
    await locks[STOP_COMPONENT]?.()
  })

  it('should keep a connection free for other entities and run the waiter once the lock is released', async () => {
    expect({ otherEntity, holder: await holder, waiter: await waiter }).toEqual({
      otherEntity: 'other entity',
      holder: 'holder',
      waiter: 'waiter'
    })
  })
})

test('when uploads arrive while garbage collection holds the exclusive lock', ({ components }) => {
  let locks: IContentLocks
  let gc: Promise<string>
  let uploads: Promise<string[]>
  let lockWaiters: number

  beforeEach(async () => {
    locks = await createContentLocks({
      config: {
        ...components.config,
        getNumber: async (key: string) => (key === 'CONTENT_LOCK_CONNECTIONS' ? 2 : components.config.getNumber(key))
      },
      logs: components.logs,
      metrics: components.metrics
    })
    await locks[START_COMPONENT]?.({} as any)
    let releaseGc!: () => void
    const held = new Promise<void>((resolve) => (releaseGc = resolve))
    gc = locks.withWrite(async () => {
      await held
      return 'gc'
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    uploads = Promise.all([1, 2, 3].map((i) => locks.withRead(async () => `upload ${i}`)))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const waiting = await components.database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`
    )
    lockWaiters = Number(waiting.rows[0].count)
    releaseGc()
  })

  afterEach(async () => {
    await Promise.allSettled([gc, uploads])
    await locks[STOP_COMPONENT]?.()
  })

  it('should not hold connections waiting on the lock and run every upload once GC finishes', async () => {
    expect({ lockWaiters, gc: await gc, uploads: await uploads }).toEqual({
      lockWaiters: 0,
      gc: 'gc',
      uploads: ['upload 1', 'upload 2', 'upload 3']
    })
  })
})
