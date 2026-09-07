import { test } from '../components'
import { loadHttpGolden, PulseRealmsBody } from '../fixtures/iteration-2/http-goldens'

/**
 * C4-live-data / WP5-flag-default-today, through the real component graph.
 *
 * Every other presence test either builds the comms adapter by hand or spies on
 * `commsAdapter.status()`, so `src/components.ts`'s own wiring of `PRESENCE_SOURCE` into
 * `createCommsAdapterComponent` — the thing an operator actually flips — was never exercised. Here
 * the flag is set in the environment `initComponents()` reads, the adapter it builds is the one the
 * routes are served from, and the only thing replaced is the transport underneath the service's
 * fetch component, so the Pulse read is answered from the contract golden instead of the network.
 */
const PULSE_URL = 'https://pulse.example.com'

type PulseSpy = { realmsRequests: string[] }

function pulseSpy(): PulseSpy {
  const container = globalThis as unknown as { __wp5PulseSpy?: PulseSpy }
  container.__wp5PulseSpy = container.__wp5PulseSpy ?? { realmsRequests: [] }
  return container.__wp5PulseSpy
}

jest.mock('../../src/adapters/fetch', () => {
  const actual = jest.requireActual('../../src/adapters/fetch')
  const { loadHttpGolden: loadGolden } = jest.requireActual('../fixtures/iteration-2/http-goldens')
  const realms = loadGolden('realms')
  const spied = (globalThis as unknown as { __wp5PulseSpy?: PulseSpy })

  return {
    ...actual,
    createFetchComponent: async () => {
      const real = await actual.createFetchComponent()

      return {
        async fetch(url: unknown, init: unknown) {
          const requested = String(url)
          if (requested.startsWith('https://pulse.example.com')) {
            spied.__wp5PulseSpy = spied.__wp5PulseSpy ?? { realmsRequests: [] }
            spied.__wp5PulseSpy.realmsRequests.push(requested)
            return new Response(JSON.stringify(realms.body), {
              headers: { 'Content-Type': 'application/json' }
            })
          }
          return real.fetch(url, init)
        }
      }
    }
  }
})

const previousEnv = {
  USE_REAL_COMMS_ADAPTER: process.env.USE_REAL_COMMS_ADAPTER,
  PRESENCE_SOURCE: process.env.PRESENCE_SOURCE,
  PULSE_URL: process.env.PULSE_URL
}

// Set before the runner builds its program: this is exactly how the flag reaches the service.
process.env.USE_REAL_COMMS_ADAPTER = 'true'
process.env.PRESENCE_SOURCE = 'pulse'
process.env.PULSE_URL = PULSE_URL

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

test('PRESENCE_SOURCE=pulse wired by initComponents', function ({ components }) {
  const realmsGolden = loadHttpGolden<PulseRealmsBody>('realms')

  it('serves /live-data from Pulse with the contract payload', async () => {
    const response = await components.localFetch.fetch('/live-data')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        totalUsers: 1,
        perWorld: [{ worldName: 'cozyfarm.dcl.eth', users: 1 }]
      },
      lastUpdated: realmsGolden.body.lastUpdated
    })
  })

  it('reads the realms endpoint of the configured PULSE_URL and nothing else', () => {
    expect(pulseSpy().realmsRequests).toEqual([`${PULSE_URL}/realms`])
  })

  it('serves /status comms counters from Pulse while adapterType still names the transport', async () => {
    const response = await components.localFetch.fetch('/status')

    expect(response.status).toBe(200)
    expect((await response.json()).comms).toMatchObject({
      adapterType: 'livekit',
      users: 1,
      rooms: 1
    })
  })
})
