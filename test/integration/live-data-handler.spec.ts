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
 * C4: the source of the counters swaps, the published shape does not. Both adapters below describe
 * the same world set — the golden `http/realms.json` on the Pulse side, the equivalent LiveKit room
 * listing on the other — so `/live-data` and `/status` must answer identically.
 */
test('GET /live-data and /status over the Pulse presence source', function ({ components }) {
  const realmsGolden = loadHttpGolden<PulseRealmsBody>('realms')
  const PULSE_URL = 'https://pulse.example.com'

  const baseConfig = {
    COMMS_ADAPTER: 'livekit',
    LIVEKIT_HOST: 'livekit.host',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret',
    COMMS_ROOM_PREFIX: 'world-',
    SCENE_ROOM_PREFIX: 'world-scene-room-'
  }

  async function buildAdapter(overrides: Record<string, string>): Promise<ICommsAdapter> {
    const { logs, metrics } = components
    const config = await createConfigComponent({ ...baseConfig, ...overrides })
    const fetch: IFetchComponent = {
      fetch: async (): Promise<Response> => new Response(JSON.stringify(realmsGolden.body))
    }
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

  async function serveFrom(overrides: Record<string, string>): Promise<void> {
    const adapter = await buildAdapter(overrides)
    jest.spyOn(components.commsAdapter, 'status').mockImplementation(() => adapter.status())
  }

  it('serves /live-data from Pulse with the contract payload', async () => {
    await serveFrom({ PRESENCE_SOURCE: 'pulse', PULSE_URL })

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

  it('serves the same /live-data payload from Pulse as from LiveKit', async () => {
    await serveFrom({})
    const fromLivekit = await (await components.localFetch.fetch('/live-data')).json()

    await serveFrom({ PRESENCE_SOURCE: 'pulse', PULSE_URL })
    const fromPulse = await (await components.localFetch.fetch('/live-data')).json()

    expect(fromPulse.data).toEqual(fromLivekit.data)
    expect(Object.keys(fromPulse).sort()).toEqual(Object.keys(fromLivekit).sort())
  })

  it('serves /status comms counters from Pulse without changing adapterType', async () => {
    await serveFrom({ PRESENCE_SOURCE: 'pulse', PULSE_URL })

    const r = await components.localFetch.fetch('/status')

    expect(r.status).toBe(200)
    expect((await r.json()).comms).toMatchObject({
      adapterType: 'livekit',
      users: 1,
      rooms: 1
    })
  })
})
