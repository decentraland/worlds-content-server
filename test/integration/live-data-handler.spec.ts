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

  it('serves /status comms counters from Pulse without changing adapterType', async () => {
    await serveFromPulse()

    const r = await components.localFetch.fetch('/status')

    expect(r.status).toBe(200)
    expect((await r.json()).comms).toMatchObject({
      adapterType: 'livekit',
      users: 1,
      rooms: 1
    })
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
})
