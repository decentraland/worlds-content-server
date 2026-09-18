import { test } from '../components'

// Set before the runner builds the app in `beforeAll`, so it boots with an allowance small enough
// to spend in a test. `process.env` wins over `.env.default` in the config provider.
process.env.POST_ENTITIES_RATE_LIMIT_MAX = '2'
process.env.POST_ENTITIES_RATE_LIMIT_WINDOW_SECONDS = '60'
process.env.TRUSTED_CLIENT_IP_HEADER = 'x-forwarded-for'

test('POST /entities rate limit wiring', function ({ components }) {
  afterAll(() => {
    delete process.env.POST_ENTITIES_RATE_LIMIT_MAX
    delete process.env.POST_ENTITIES_RATE_LIMIT_WINDOW_SECONDS
    delete process.env.TRUSTED_CLIENT_IP_HEADER
  })

  it('rejects a client past its allowance on the real route', async () => {
    const { localFetch } = components
    const headers = { 'x-forwarded-for': '198.51.100.7' }

    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      const response = await localFetch.fetch('/entities', { method: 'POST', headers })
      statuses.push(response.status)
    }

    // The bodies are not valid deployments, so the first two are rejected by the parser. What
    // matters is that they were counted and the third never got that far.
    expect(statuses[0]).not.toEqual(429)
    expect(statuses[1]).not.toEqual(429)
    expect(statuses[2]).toEqual(429)
  })
})
