import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { test } from '../components'
import { createContentLocks } from '../../src/adapters/content-locks/component'
import { ContentLockTimeoutError } from '../../src/adapters/content-locks/errors'
import { IContentLocks } from '../../src/adapters/content-locks/types'
import { Client } from 'pg'
import { countAdvisoryLocks, waitForAdvisoryLocks } from '../utils'

const GATE = 'worlds-content-gc'
const WRITER_GATE_ATTEMPT = "pg_try_advisory_lock(hashtextextended('worlds-content-gc', 0))"
const ENTITY_LOCK_ATTEMPT = 'pg_try_advisory_lock(hashtextextended($1, 0))'

// Try-locks never queue in pg_locks, so retries are observed as the lock statements actually issued.
async function waitForLockAttempts(
  querySpy: jest.SpyInstance,
  matches: (text: string, values: unknown[]) => boolean,
  count: number,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const attempts = (): number =>
    querySpy.mock.calls.filter(([query]) => {
      const { text, values } = typeof query === 'string' ? { text: query, values: [] } : (query ?? {})
      return typeof text === 'string' && matches(text, values ?? [])
    }).length
  while (attempts() < count) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} lock attempts`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Resolves 'blocked' if the operation hasn't settled within `ms`, clearing the sentinel timer either way.
async function orBlocked(operation: Promise<string>, ms: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Samples the queued sessions on `keyName` across `windowMs` and returns the most seen at once.
async function maxAdvisoryWaiters(
  db: Parameters<typeof countAdvisoryLocks>[0],
  keyName: string,
  windowMs: number
): Promise<number> {
  const deadline = Date.now() + windowMs
  let max = 0
  do {
    max = Math.max(max, await countAdvisoryLocks(db, keyName, 'waiting'))
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  return max
}

test('when requests wait for a busy entity lock', ({ components }) => {
  let locks: IContentLocks
  let releaseHolder: () => void
  let holder: Promise<string>
  let waiter: Promise<string>
  let otherEntity: string
  let results: string[]
  let querySpy: jest.SpyInstance

  beforeEach(async () => {
    querySpy = jest.spyOn(Client.prototype, 'query')
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
    await waitForAdvisoryLocks(components.database, 'partial-entity:busy-entity', 'granted')
    waiter = locks.withRead(async () => 'waiter', undefined, 'busy-entity')
    // The holder's attempt plus two of the waiter's: it has retried against the busy entity.
    await waitForLockAttempts(
      querySpy,
      (text, values) => text.includes(ENTITY_LOCK_ATTEMPT) && values[0] === 'partial-entity:busy-entity',
      3
    )
    otherEntity = await orBlocked(
      locks.withRead(async () => 'other entity', undefined, 'free-entity'),
      3000
    )
    releaseHolder()
    results = await Promise.all([holder, waiter])
  })

  afterEach(async () => {
    await Promise.allSettled([holder, waiter])
    await locks[STOP_COMPONENT]?.()
    querySpy.mockRestore()
  })

  it('should keep a connection free for other entities', () => {
    expect(otherEntity).toBe('other entity')
  })

  it('should run the waiter once the lock is released', () => {
    expect(results).toEqual(['holder', 'waiter'])
  })
})

test('when uploads arrive while garbage collection holds the exclusive lock', ({ components }) => {
  let locks: IContentLocks
  let gc: Promise<string>
  let uploads: Promise<string[]>
  let lockWaiters: number
  let results: [string, string[]]

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
    await waitForAdvisoryLocks(components.database, GATE, 'granted')
    uploads = Promise.all([1, 2, 3].map((i) => locks.withRead(async () => `upload ${i}`)))
    lockWaiters = await maxAdvisoryWaiters(components.database, GATE, 300)
    releaseGc()
    results = await Promise.all([gc, uploads])
  })

  afterEach(async () => {
    await Promise.allSettled([gc, uploads])
    await locks[STOP_COMPONENT]?.()
  })

  it('should not hold connections waiting on the lock', () => {
    expect(lockWaiters).toBe(0)
  })

  it('should run every upload once GC finishes', () => {
    expect(results).toEqual(['gc', ['upload 1', 'upload 2', 'upload 3']])
  })
})

test('when several writers wait behind an upload holding the shared lock', ({ components }) => {
  let locks: IContentLocks
  let upload: Promise<string>
  let writers: Promise<string[]>
  let lockWaiters: number
  let writerResults: string[]

  beforeEach(async () => {
    locks = await createContentLocks({
      config: {
        ...components.config,
        getNumber: async (key: string) => (key === 'CONTENT_LOCK_CONNECTIONS' ? 3 : components.config.getNumber(key))
      },
      logs: components.logs,
      metrics: components.metrics
    })
    await locks[START_COMPONENT]?.({} as any)
    let releaseUpload!: () => void
    const held = new Promise<void>((resolve) => (releaseUpload = resolve))
    upload = locks.withRead(async () => {
      await held
      return 'upload'
    })
    await waitForAdvisoryLocks(components.database, GATE, 'granted')
    writers = Promise.all([1, 2, 3].map((i) => locks.withWrite(async () => `writer ${i}`)))
    lockWaiters = await maxAdvisoryWaiters(components.database, GATE, 300)
    releaseUpload()
    writerResults = await writers
  })

  afterEach(async () => {
    await Promise.allSettled([upload, writers])
    await locks[STOP_COMPONENT]?.()
  })

  it('should keep every writer off the lock queue', () => {
    expect(lockWaiters).toBe(0)
  })

  it('should run all of the writers once the upload ends', () => {
    expect(writerResults).toEqual(['writer 1', 'writer 2', 'writer 3'])
  })
})

test('when an upload arrives while a writer waits behind another upload', ({ components }) => {
  let locks: IContentLocks
  let upload: Promise<string>
  let writer: Promise<string>
  let laterUpload: string
  let writerResult: string
  let querySpy: jest.SpyInstance

  beforeEach(async () => {
    querySpy = jest.spyOn(Client.prototype, 'query')
    locks = await createContentLocks({
      config: {
        ...components.config,
        getNumber: async (key: string) => (key === 'CONTENT_LOCK_CONNECTIONS' ? 3 : components.config.getNumber(key))
      },
      logs: components.logs,
      metrics: components.metrics
    })
    await locks[START_COMPONENT]?.({} as any)
    let releaseUpload!: () => void
    const held = new Promise<void>((resolve) => (releaseUpload = resolve))
    upload = locks.withRead(async () => {
      await held
      return 'upload'
    })
    await waitForAdvisoryLocks(components.database, GATE, 'granted')
    writer = locks.withWrite(async () => 'writer')
    // The writer has tried the gate and retried before the later upload arrives.
    await waitForLockAttempts(querySpy, (text) => text.includes(WRITER_GATE_ATTEMPT), 2)
    laterUpload = await orBlocked(
      locks.withRead(async () => 'later upload'),
      1_000
    )
    releaseUpload()
    writerResult = await writer
  })

  afterEach(async () => {
    await Promise.allSettled([upload, writer])
    await locks[STOP_COMPONENT]?.()
    querySpy.mockRestore()
  })

  it('should let the new upload proceed without waiting for the writer', () => {
    expect(laterUpload).toBe('later upload')
  })

  it('should run the writer once the uploads end', () => {
    expect(writerResult).toBe('writer')
  })
})

test('when a writer waits behind an upload that keeps the shared lock past the bounded wait', ({ components }) => {
  let locks: IContentLocks
  let upload: Promise<string>
  let writerError: unknown
  let laterUpload: string

  beforeEach(async () => {
    locks = await createContentLocks(
      {
        config: {
          ...components.config,
          getNumber: async (key: string) => (key === 'CONTENT_LOCK_CONNECTIONS' ? 3 : components.config.getNumber(key))
        },
        logs: components.logs,
        metrics: components.metrics
      },
      { writerRetryMaxMs: 100, writerMaxWaitMs: 1_000 }
    )
    await locks[START_COMPONENT]?.({} as any)
    let releaseUpload!: () => void
    const held = new Promise<void>((resolve) => (releaseUpload = resolve))
    upload = locks.withRead(async () => {
      await held
      return 'upload'
    })
    await waitForAdvisoryLocks(components.database, GATE, 'granted')
    writerError = await locks.withWrite(async () => 'writer').catch((e) => e)
    laterUpload = await orBlocked(
      locks.withRead(async () => 'later upload'),
      3000
    )
    releaseUpload()
  })

  afterEach(async () => {
    await Promise.allSettled([upload])
    await locks[STOP_COMPONENT]?.()
  })

  it('should fail the writer with the typed busy error and leave the gate open to later uploads', () => {
    expect({ writerError, laterUpload }).toEqual({
      writerError: new ContentLockTimeoutError(),
      laterUpload: 'later upload'
    })
  })
})

test('when the lock pool stays saturated until the request deadline', ({ components }) => {
  let locks: IContentLocks
  let holder: Promise<string>
  let deadline: Error
  let error: unknown

  beforeEach(async () => {
    locks = await createContentLocks(
      {
        config: {
          ...components.config,
          getNumber: async (key: string) => (key === 'CONTENT_LOCK_CONNECTIONS' ? 1 : components.config.getNumber(key))
        },
        logs: components.logs,
        metrics: components.metrics
      },
      { connectionTimeoutMs: 100 }
    )
    await locks[START_COMPONENT]?.({} as any)
    let releaseHolder!: () => void
    const held = new Promise<void>((resolve) => (releaseHolder = resolve))
    holder = locks.withRead(async () => {
      await held
      return 'holder'
    })
    await waitForAdvisoryLocks(components.database, GATE, 'granted')
    deadline = new Error('processing deadline')
    const controller = new AbortController()
    setTimeout(() => controller.abort(deadline), 400)
    error = await locks.withRead(async () => 'blocked', controller.signal, 'saturated-entity').catch((e) => e)
    releaseHolder()
  })

  afterEach(async () => {
    await Promise.allSettled([holder])
    await locks[STOP_COMPONENT]?.()
  })

  it('should keep retrying and end with the request deadline instead of a raw pool timeout', () => {
    expect(error).toBe(deadline)
  })
})
