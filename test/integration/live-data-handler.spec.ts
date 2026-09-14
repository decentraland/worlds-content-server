import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IFetchComponent } from '@dcl/core-commons'
import { test } from '../components'
import { createCommsAdapterComponent } from '../../src/adapters/comms-adapter'
import { ICommsAdapter } from '../../src/types'
import { createMockLivekitClient } from '../mocks/livekit-client-mock'
import { loadHttpGolden, PulseRealmsBody } from '../fixtures/iteration-2/http-goldens'

test('GET /live-data', function ({ components }) {
  it('returns the live data', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/live-data')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      data: {
        totalUsers: 2,
        perWorld: [
          {
            worldName: 'world-name.dcl.eth',
            users: 2
          }
        ]
      },
      lastUpdated: expect.any(String)
    })
  })
})

/**
 * C4: Pulse is the only presence source. The golden `http/realms.json` and the LiveKit room listing
 * below describe the same world set (`cozyfarm.dcl.eth` with one user) just to keep the fixture
 * realistic — `/live-data` and `/status` always read their counters from Pulse.
 */
test('GET /live-data and /status over Pulse', function ({ components }) {
  const realmsGolden = loadHttpGolden<PulseRealmsBody>('realms')
  const PULSE_URL = 'https://pulse.example.com'

  const baseConfig = {
    COMMS_ADAPTER: 'livekit',
    LIVEKIT_HOST: 'livekit.host',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret',
    COMMS_ROOM_PREFIX: 'world-',
    SCENE_ROOM_PREFIX: 'world-scene-room-',
    PULSE_URL
  }

  async function buildAdapter(fetch: IFetchComponent): Promise<ICommsAdapter> {
    const { logs, metrics } = components
    const config = await createConfigComponent(baseConfig)
    return createCommsAdapterComponent({
      config,
      fetch,
      logs,
      livekitClient: createMockLivekitClient({
        // The same world set the golden describes: cozyfarm.dcl.eth with a single peer.
        listRoomsWithParticipantCounts: jest
          .fn()
          .mockResolvedValue([{ name: 'world-cozyfarm.dcl.eth', numParticipants: 1 }])
      }),
      metrics
    })
  }

  async function serveFromPulse(): Promise<void> {
    const adapter = await buildAdapter({
      fetch: async (): Promise<Response> => new Response(JSON.stringify(realmsGolden.body))
    })
    jest.spyOn(components.commsAdapter, 'status').mockImplementation(() => adapter.status())
  }

  it('serves /live-data from Pulse with the contract payload', async () => {
    await serveFromPulse()

    const r = await components.localFetch.fetch('/live-data')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      data: {
        totalUsers: 1,
        perWorld: [{ worldName: 'cozyfarm.dcl.eth', users: 1 }]
      },
      lastUpdated: realmsGolden.body.lastUpdated
    })
  })

  // `/status`'s `comms` block deliberately omits `details` (a pre-existing, WP5-unrelated choice:
  // per-world detail is `/live-data`'s job) — `users`/`rooms` are exactly the aggregate of the same
  // `CommsStatus.details` the comms-adapter unit suite pins directly
  // (`test/unit/comms-adapter.spec.ts`'s "presence" describe), so the C4 shape is covered end to end
  // across the two suites rather than by re-asserting `details` on a response that never carries it.
  it('serves /status comms counters from Pulse without changing adapterType', async () => {
    await serveFromPulse()

    const r = await components.localFetch.fetch('/status')
    const body = await r.json()

    expect(r.status).toBe(200)
    expect(body.comms).toMatchObject({
      adapterType: 'livekit',
      users: 1,
      rooms: 1
    })
    expect(body.comms.details).toBeUndefined()
  })

  // C4-no-fallback: a Pulse outage with nothing fresh enough to serve answers 503, never a
  // LiveKit-derived count — even though the mocked transport below could answer one.
  it('answers 503 from /live-data when Pulse has never answered successfully', async () => {
    const adapter = await buildAdapter({
      fetch: async (): Promise<Response> => {
        throw new Error('pulse is down')
      }
    })
    jest.spyOn(components.commsAdapter, 'status').mockImplementation(() => adapter.status())

    const r = await components.localFetch.fetch('/live-data')

    expect(r.status).toBe(503)
  })

  // Mirrors the /live-data case above: /status must map the same rejection to the same 503,
  // never falling back to a LiveKit-derived count (review round 1, finding 4 — this route had no
  // test at all).
  it('answers 503 from /status when Pulse has never answered successfully', async () => {
    const adapter = await buildAdapter({
      fetch: async (): Promise<Response> => {
        throw new Error('pulse is down')
      }
    })
    jest.spyOn(components.commsAdapter, 'status').mockImplementation(() => adapter.status())

    const r = await components.localFetch.fetch('/status')

    expect(r.status).toBe(503)
  })

  // C4-no-fallback / C4-live-data-shape (M2): a 200 whose body is not `{ realms: [...] }` is a
  // failed read, not "nobody is online" — both routes must answer 503, never an invented empty body.
  it('answers 503 from /live-data and /status when Pulse answers 200 with a malformed body', async () => {
    const adapter = await buildAdapter({
      fetch: async (): Promise<Response> => new Response(JSON.stringify({ message: 'upstream connect error' }))
    })
    jest.spyOn(components.commsAdapter, 'status').mockImplementation(() => adapter.status())

    const liveDataResponse = await components.localFetch.fetch('/live-data')
    const statusResponse = await components.localFetch.fetch('/status')

    expect(liveDataResponse.status).toBe(503)
    expect(statusResponse.status).toBe(503)
  })
})
