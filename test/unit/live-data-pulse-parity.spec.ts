import { getLiveDataHandler } from '../../src/controllers/handlers/live-data-handler'
import { pulseSourcedAdapter } from '../../src/adapters/comms-adapter'
import { HandlerContextWithPath, ICommsAdapter } from '../../src/types'
import { IFetchComponent } from '@dcl/core-commons'
import { createMockLogs } from '../mocks/logs-mock'
import { loadHttpGolden, PulseRealmsBody } from '../fixtures/iteration-2/http-goldens'

/**
 * C4-live-data: the pack's `/realms` golden must produce exactly the `/live-data` body shape pinned
 * by the plan — `{"data":{"totalUsers":N,"perWorld":[{"worldName":…,"users":…}]},"lastUpdated":"…"}`.
 * There is no `http/today/live-data.json` probe in the pack to diff against, so this fixture-to-shape
 * mapping is the only guard against the response drifting.
 *
 * This drives the *production* `pulseSourcedAdapter` (review round 1, finding 8) rather than a
 * hand-rolled `status()` that re-implements the mapping: a hand-rolled stand-in would still pass
 * here even if `pulseStatus()` drifted (dropped `details`, switched `timestamp` to `Date.now()`),
 * since it would just be asserting its own arithmetic.
 */
describe('live-data / Pulse realms fixture parity', () => {
  const realmsGolden = loadHttpGolden<PulseRealmsBody>('realms')
  const PULSE_URL = 'https://pulse.example.com'

  /**
   * `publishesCommitHash: false` below means `pulseSourcedAdapter` never calls
   * `transportAdapter.status()` — this transport exists only to satisfy the parameter and must never
   * be queried, so every method throws if it is.
   */
  const unreachableTransport: ICommsAdapter = {
    status: async () => {
      throw new Error('the transport must not be queried when publishesCommitHash is false')
    },
    getWorldRoomConnectionString: async () => '',
    getSceneRoomConnectionString: async () => '',
    getWorldRoomParticipantCount: async () => 0,
    getWorldSceneRoomsParticipantCount: async () => 0,
    removeParticipant: async () => undefined
  }

  function realCommsAdapterFromGolden(): ICommsAdapter {
    const fetch: IFetchComponent = {
      fetch: async () => new Response(JSON.stringify(realmsGolden.body))
    }
    return pulseSourcedAdapter({ fetch, logs: createMockLogs() }, unreachableTransport, {
      pulseUrl: PULSE_URL,
      adapterType: 'livekit',
      statusUrl: 'https://livekit.dcl.org/',
      publishesCommitHash: false
    })
  }

  it('produces exactly the C4 /live-data shape from the pack /realms golden', async () => {
    const context = {
      components: { commsAdapter: realCommsAdapterFromGolden() }
    } as unknown as HandlerContextWithPath<'commsAdapter', '/live-data'>

    const response = await getLiveDataHandler(context)

    expect(response).toEqual({
      status: 200,
      body: {
        data: {
          totalUsers: 1,
          perWorld: [{ worldName: 'cozyfarm.dcl.eth', users: 1 }]
        },
        lastUpdated: realmsGolden.body.lastUpdated
      }
    })
  })

  it('excludes Genesis City and keeps world names canonically lowercase', () => {
    const worldRealms = realmsGolden.body.realms.filter((realm) => realm.name.endsWith('.dcl.eth'))

    expect(worldRealms).toEqual([{ name: 'cozyfarm.dcl.eth', peers: 1, clusters: 1 }])
    expect(worldRealms.every((realm) => realm.name === realm.name.toLowerCase())).toBe(true)
  })
})
