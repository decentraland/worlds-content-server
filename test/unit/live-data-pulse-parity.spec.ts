import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@dcl/metrics'
import { IFetchComponent, IHttpServerComponent } from '@dcl/core-commons'
import { createCommsAdapterComponent } from '../../src/adapters/comms-adapter'
import { getLiveDataHandler } from '../../src/controllers/handlers/live-data-handler'
import { statusHandler } from '../../src/controllers/handlers/status-handler'
import { metricDeclarations } from '../../src/metrics'
import { HandlerContextWithPath, ICommsAdapter } from '../../src/types'
import { createMockLivekitClient } from '../mocks/livekit-client-mock'
import { createMockedConfig } from '../mocks/config-mock'
import { loadHttpGolden, PulseRealmsBody } from '../fixtures/iteration-2/http-goldens'

/**
 * C4 acceptance: `/live-data` and `/status.comms` must answer exactly the same shape whether the
 * counters come from LiveKit or from Pulse. The golden `http/realms.json` and the LiveKit room
 * listing below describe the same world set (`cozyfarm.dcl.eth` with one user), so the two answers
 * have to match field for field.
 */
describe('live data and status over the presence sources', () => {
  const realmsGolden = loadHttpGolden<PulseRealmsBody>('realms')
  const PULSE_URL = 'https://pulse.example.com'
  const metrics = createTestMetricsComponent(metricDeclarations)

  const baseConfig = {
    COMMS_ADAPTER: 'livekit',
    LIVEKIT_HOST: 'livekit.dcl.org',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret',
    COMMS_ROOM_PREFIX: 'world-',
    SCENE_ROOM_PREFIX: 'world-scene-room-'
  }

  async function buildAdapter(overrides: Record<string, string>, fetchImpl: jest.Mock): Promise<ICommsAdapter> {
    const config = await createConfigComponent({ ...baseConfig, ...overrides })
    const logs = await createLogComponent({ config })
    return createCommsAdapterComponent({
      config,
      fetch: { fetch: fetchImpl } as unknown as IFetchComponent,
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

  function liveDataContext(commsAdapter: ICommsAdapter): HandlerContextWithPath<'commsAdapter', '/live-data'> {
    return { components: { commsAdapter } } as unknown as HandlerContextWithPath<'commsAdapter', '/live-data'>
  }

  function statusContext(
    commsAdapter: ICommsAdapter
  ): HandlerContextWithPath<'commsAdapter' | 'config' | 'worldsManager', '/status'> {
    const config = createMockedConfig()
    config.getString.mockResolvedValue('some-commit-hash')
    return {
      components: {
        commsAdapter,
        config,
        worldsManager: { getDeployedWorldCount: jest.fn().mockResolvedValue({ ens: 0, dcl: 1 }) }
      }
    } as unknown as HandlerContextWithPath<'commsAdapter' | 'config' | 'worldsManager', '/status'>
  }

  let livekitLiveData: IHttpServerComponent.IResponse
  let pulseLiveData: IHttpServerComponent.IResponse
  let livekitStatus: IHttpServerComponent.IResponse
  let pulseStatus: IHttpServerComponent.IResponse

  beforeEach(async () => {
    const livekitFetch = jest.fn()
    const pulseFetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify(realmsGolden.body)))

    const livekitAdapter = await buildAdapter({}, livekitFetch)
    const pulseAdapter = await buildAdapter({ PRESENCE_SOURCE: 'pulse', PULSE_URL }, pulseFetch)

    livekitLiveData = await getLiveDataHandler(liveDataContext(livekitAdapter))
    pulseLiveData = await getLiveDataHandler(liveDataContext(pulseAdapter))
    livekitStatus = await statusHandler(statusContext(livekitAdapter))
    pulseStatus = await statusHandler(statusContext(pulseAdapter))
  })

  it('should answer /live-data with the contract shape when the source is Pulse', () => {
    expect(pulseLiveData).toEqual({
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

  it('should answer /live-data with the same payload as the LiveKit source', () => {
    expect((pulseLiveData.body as any).data).toEqual((livekitLiveData.body as any).data)
    expect(Object.keys(pulseLiveData.body as any).sort()).toEqual(Object.keys(livekitLiveData.body as any).sort())
  })

  it('should answer /status with the Pulse counters', () => {
    expect((pulseStatus.body as any).comms).toMatchObject({
      adapterType: 'livekit',
      users: 1,
      rooms: 1,
      details: undefined
    })
  })

  it('should answer /status with the same comms shape as the LiveKit source', () => {
    const pulseComms = (pulseStatus.body as any).comms
    const livekitComms = (livekitStatus.body as any).comms
    expect(Object.keys(pulseComms).sort()).toEqual(Object.keys(livekitComms).sort())
    expect(pulseComms.adapterType).toEqual(livekitComms.adapterType)
    expect(pulseComms.statusUrl).toEqual(livekitComms.statusUrl)
    expect(pulseComms.users).toEqual(livekitComms.users)
    expect(pulseComms.rooms).toEqual(livekitComms.rooms)
  })
})
