import { createServerComponent, Router } from '@dcl/http-server'
import { defaultServerConfig } from '@dcl/test-helpers'
import { createRecordConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@dcl/metrics'
import { metricDeclarations } from '../../src/metrics'
import {
  createHttpRateLimiterComponent,
  createPostEntitiesRateLimitMiddlewares
} from '../../src/logic/http-rate-limiter'
import { GlobalContext } from '../../src/types'

type TestServer = {
  baseUrl: string
  handledRequests: () => number
  stop: () => Promise<void>
}

/**
 * Mounts the rate-limit middlewares exactly as `setupRouter` does — ahead of the handler that would
 * read the upload — on a server carrying nothing else, so a 429 here can only come from them.
 */
async function startRateLimitedServer(overrides: Record<string, string>): Promise<TestServer> {
  const serverConfig = { ...defaultServerConfig(), HTTP_SERVER_HOST: '127.0.0.1' }
  const config = createRecordConfigComponent({ ...serverConfig, ...overrides })
  const logs = await createLogComponent({ config })
  const metrics = createTestMetricsComponent(metricDeclarations)
  const server = await createServerComponent<GlobalContext>({ config, logs }, { http: {} })

  const rateLimiter = await createHttpRateLimiterComponent({ config, logs, metrics })
  const middlewares = await createPostEntitiesRateLimitMiddlewares({ config, rateLimiter })

  let handledRequests = 0
  const router = new Router<GlobalContext>()
  router.post('/entities', ...middlewares, async () => {
    handledRequests++
    return { status: 200, body: { ok: true } }
  })

  server.use(router.middleware())
  server.setContext({ components: {} } as GlobalContext)
  await server.start!({ started: () => true, live: () => true, getComponents: () => ({}) })

  return {
    baseUrl: `http://${serverConfig.HTTP_SERVER_HOST}:${serverConfig.HTTP_SERVER_PORT}`,
    handledRequests: () => handledRequests,
    stop: () => server.stop()
  }
}

describe('POST /entities rate limiting', () => {
  let testServer: TestServer | undefined

  afterEach(async () => {
    await testServer?.stop()
    testServer = undefined
  })

  it('rejects with 429 once the burst allowance is spent, without reaching the handler', async () => {
    testServer = await startRateLimitedServer({
      POST_ENTITIES_RATE_LIMIT_MAX: '2',
      POST_ENTITIES_RATE_LIMIT_WINDOW_SECONDS: '60',
      TRUSTED_CLIENT_IP_HEADER: 'x-forwarded-for'
    })

    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${testServer.baseUrl}/entities`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.10' }
      })
      statuses.push(response.status)
    }

    expect(statuses).toEqual([200, 200, 429])
    // The point of mounting ahead of the parser: a throttled client must not get to spend the upload.
    expect(testServer.handledRequests()).toBe(2)
  })

  it('counts the daily quota in its own bucket, so it bites while the burst allowance is untouched', async () => {
    testServer = await startRateLimitedServer({
      // Generous enough that a shared counter would let all three requests through; only a separate
      // daily bucket rejects the third.
      POST_ENTITIES_RATE_LIMIT_MAX: '5',
      POST_ENTITIES_RATE_LIMIT_WINDOW_SECONDS: '60',
      POST_ENTITIES_DAILY_QUOTA_MAX: '2',
      TRUSTED_CLIENT_IP_HEADER: 'x-forwarded-for'
    })

    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${testServer.baseUrl}/entities`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.20' }
      })
      statuses.push(response.status)
    }

    expect(statuses).toEqual([200, 200, 429])
    expect(testServer.handledRequests()).toBe(2)
  })

  it('fails at startup naming the offending setting, rather than flooring it to one request', async () => {
    const config = createRecordConfigComponent({ POST_ENTITIES_DAILY_QUOTA_MAX: '0' })
    const logs = await createLogComponent({ config })
    const metrics = createTestMetricsComponent(metricDeclarations)
    const rateLimiter = await createHttpRateLimiterComponent({ config, logs, metrics })

    // Two mounts read a `max`, so an error naming only "max" leaves an operator guessing which
    // variable to fix.
    await expect(createPostEntitiesRateLimitMiddlewares({ config, rateLimiter })).rejects.toThrow(
      'POST_ENTITIES_DAILY_QUOTA_MAX'
    )
  })
})
