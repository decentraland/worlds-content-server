import { IFetchComponent } from '@dcl/core-commons'
import { ILoggerComponent } from '@well-known-components/interfaces'
import {
  fetchPulsePeerRealm,
  fetchPulseRealms,
  getPresenceSource,
  isWorldRealm,
  PULSE_REQUEST_TIMEOUT_MS,
  worldStatusesFromRealms
} from '../../src/logic/presence-source'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { loadHttpGolden, PulsePeerBody, PulseRealmsBody } from '../fixtures/iteration-2/http-goldens'

const PULSE_URL = 'https://pulse.example.com'

describe('presence-source', () => {
  const realmsGolden = loadHttpGolden<PulseRealmsBody>('realms')
  const peerGolden = loadHttpGolden<PulsePeerBody>('peers-single')

  describe('when mapping the Pulse realm list onto world statuses', () => {
    it('should keep only the realms that are worlds', () => {
      expect(
        worldStatusesFromRealms([
          { name: 'main', peers: 4, clusters: 2 },
          { name: 'cozyfarm.dcl.eth', peers: 1, clusters: 1 }
        ])
      ).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
    })

    // C4-live-data: `worldName` stays lowercase. The pack pins realm names as canonical lowercase
    // at Pulse ingest and asks consumers to treat a non-lowercase value on the wire as a contract
    // violation to log, not to drop (`07-invalid-mixed-case-realm`).
    it('should lowercase a mixed-case realm name rather than publish it verbatim', () => {
      expect(worldStatusesFromRealms([{ name: 'CozyFarm.DCL.eth', peers: 3, clusters: 1 }])).toEqual([
        { worldName: 'cozyfarm.dcl.eth', users: 3 }
      ])
    })

    it('should log the casing contract violation when a logger is given', () => {
      const logger = createMockLogs().getLogger('any') as unknown as jest.Mocked<ILoggerComponent.ILogger>

      worldStatusesFromRealms([{ name: 'CozyFarm.dcl.eth', peers: 3, clusters: 1 }], logger)

      expect(logger.warn).toHaveBeenCalledWith(
        'Pulse answered /realms with non-lowercase realm names; normalizing them',
        { realms: 'CozyFarm.dcl.eth' }
      )
    })

    it('should not log anything when every realm name is already canonical', () => {
      const logger = createMockLogs().getLogger('any') as unknown as jest.Mocked<ILoggerComponent.ILogger>

      worldStatusesFromRealms([{ name: 'cozyfarm.dcl.eth', peers: 3, clusters: 1 }], logger)

      expect(logger.warn).not.toHaveBeenCalled()
    })

    // Both transports drop empty rooms before building `details`, so the Pulse mapper has to as
    // well or `/live-data` would list a draining world the LiveKit answer for the same world set
    // omits — exactly the parity the WP5 acceptance criterion asserts.
    it('should drop a world with no peers', () => {
      expect(
        worldStatusesFromRealms([
          { name: 'draining.dcl.eth', peers: 0, clusters: 1 },
          { name: 'cozyfarm.dcl.eth', peers: 1, clusters: 1 }
        ])
      ).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
    })
  })

  describe('when recognizing world realms', () => {
    it('should accept a world realm in any casing and reject Genesis City', () => {
      expect(isWorldRealm('cozyfarm.dcl.eth')).toBe(true)
      expect(isWorldRealm('CozyFarm.DCL.ETH')).toBe(true)
      expect(isWorldRealm('main')).toBe(false)
    })
  })

  describe('when resolving the presence source', () => {
    it.each([
      [undefined, 'livekit'],
      ['livekit', 'livekit'],
      ['nonsense', 'livekit'],
      ['pulse', 'pulse'],
      ['  PULSE  ', 'pulse'],
      ['Both', 'both']
    ])('should resolve %p to %p', async (configured, expected) => {
      const config = createMockedConfig()
      config.getString.mockResolvedValue(configured)

      expect(await getPresenceSource(config)).toBe(expected)
    })
  })

  describe('when building the Pulse endpoint', () => {
    let fetchMock: jest.Mock
    let fetch: IFetchComponent

    beforeEach(() => {
      fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(realmsGolden.body)))
      fetch = { fetch: fetchMock } as unknown as IFetchComponent
    })

    it('should not double the separator when PULSE_URL carries a trailing slash', async () => {
      await fetchPulseRealms(fetch, `${PULSE_URL}/`)

      expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/realms`, expect.anything())
    })

    it('should trim every trailing slash of PULSE_URL', async () => {
      await fetchPulseRealms(fetch, `${PULSE_URL}///`)

      expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/realms`, expect.anything())
    })

    it('should trim the trailing slash for the single-peer read too', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify(peerGolden.body)))

      await fetchPulsePeerRealm(fetch, `${PULSE_URL}/`, '0x0000000000000000000000000000000000000003')

      expect(fetchMock).toHaveBeenCalledWith(
        `${PULSE_URL}/peers/0x0000000000000000000000000000000000000003`,
        expect.anything()
      )
    })
  })

  // The service's fetch component is built with no default timeout and @dcl/fetch-component only
  // arms its abort timer when one is passed, so without an explicit deadline a Pulse that accepts
  // the connection and then stalls hangs the caller for as long as the socket stays open.
  describe('when Pulse accepts the connection and then stalls', () => {
    const peerId = '0x0000000000000000000000000000000000000003'
    let fetchMock: jest.Mock
    let fetch: IFetchComponent

    beforeEach(() => {
      jest.useFakeTimers()
      fetchMock = jest.fn().mockImplementation(() => new Promise<Response>(() => undefined))
      fetch = { fetch: fetchMock } as unknown as IFetchComponent
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should give up on the realms read at the deadline', async () => {
      const pending = fetchPulseRealms(fetch, PULSE_URL)
      const rejection = expect(pending).rejects.toThrow(`Pulse request timed out after ${PULSE_REQUEST_TIMEOUT_MS} ms`)

      await jest.advanceTimersByTimeAsync(PULSE_REQUEST_TIMEOUT_MS)

      await rejection
    })

    it('should give up on the single-peer read at the deadline', async () => {
      const pending = fetchPulsePeerRealm(fetch, PULSE_URL, peerId)
      const rejection = expect(pending).rejects.toThrow(`Pulse request timed out after ${PULSE_REQUEST_TIMEOUT_MS} ms`)

      await jest.advanceTimersByTimeAsync(PULSE_REQUEST_TIMEOUT_MS)

      await rejection
    })

    it('should abort the in-flight request so the socket is released, not just abandoned', async () => {
      const pending = fetchPulseRealms(fetch, PULSE_URL).catch(() => undefined)
      const [, init] = fetchMock.mock.calls[0]

      expect(init.signal.aborted).toBe(false)

      await jest.advanceTimersByTimeAsync(PULSE_REQUEST_TIMEOUT_MS)
      await pending

      expect(init.signal.aborted).toBe(true)
    })

    it('should not fire the deadline for a read that answered in time', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify(realmsGolden.body)))

      await fetchPulseRealms(fetch, PULSE_URL)
      const [, init] = fetchMock.mock.calls[0]

      await jest.advanceTimersByTimeAsync(PULSE_REQUEST_TIMEOUT_MS * 2)

      expect(init.signal.aborted).toBe(false)
    })
  })
})
