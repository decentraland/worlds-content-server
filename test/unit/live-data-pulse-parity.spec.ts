import { getLiveDataHandler } from '../../src/controllers/handlers/live-data-handler'
import { fetchPulseRealms } from '../../src/logic/pulse'
import { HandlerContextWithPath, ICommsAdapter } from '../../src/types'
import { IFetchComponent } from '@dcl/core-commons'
import { loadHttpGolden, PulseRealmsBody } from '../fixtures/iteration-2/http-goldens'

/**
 * C4-live-data: the pack's `/realms` golden must produce exactly the `/live-data` body shape pinned
 * by the plan — `{"data":{"totalUsers":N,"perWorld":[{"worldName":…,"users":…}]},"lastUpdated":"…"}`.
 * There is no `http/today/live-data.json` probe in the pack to diff against, so this fixture-to-shape
 * mapping is the only guard against the response drifting.
 */
describe('live-data / Pulse realms fixture parity', () => {
  const realmsGolden = loadHttpGolden<PulseRealmsBody>('realms')
  const PULSE_URL = 'https://pulse.example.com'

  function commsAdapterFromGolden(): ICommsAdapter {
    const fetch: IFetchComponent = {
      fetch: async () => new Response(JSON.stringify(realmsGolden.body))
    }
    return {
      async status() {
        const { worlds, lastUpdated } = await fetchPulseRealms(fetch, PULSE_URL)
        return {
          adapterType: 'livekit',
          statusUrl: 'https://livekit.dcl.org/',
          rooms: worlds.length,
          users: worlds.reduce((carry, world) => carry + world.users, 0),
          details: worlds,
          timestamp: lastUpdated
        }
      },
      getWorldRoomConnectionString: async () => '',
      getSceneRoomConnectionString: async () => '',
      getWorldRoomParticipantCount: async () => 0,
      getWorldSceneRoomsParticipantCount: async () => 0,
      removeParticipant: async () => undefined
    }
  }

  it('produces exactly the C4 /live-data shape from the pack /realms golden', async () => {
    const context = { components: { commsAdapter: commsAdapterFromGolden() } } as unknown as HandlerContextWithPath<
      'commsAdapter',
      '/live-data'
    >

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
