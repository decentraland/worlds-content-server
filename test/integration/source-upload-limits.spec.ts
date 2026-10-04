import FormData from 'form-data'
import { ClientRequest, request } from 'http'
import { setTimeout as sleep } from 'timers/promises'
import { test } from '../components'
import { SourceUploadLease } from '../../src/adapters/source-upload-limits'

// Runs at module evaluation, before the harness initializes components; process.env wins over .env.default.
process.env.MAX_CONCURRENT_UPLOADS_PER_SOURCE = '2'

const SOURCE = '203.0.113.10'
const OTHER_SOURCE = '203.0.113.11'

test('Per-source in-flight upload limits on POST /entities', function ({ components }) {
  let baseUrl: string
  let stalled: ClientRequest[]
  let acquireSpy: jest.SpyInstance

  function form(): FormData {
    const body = new FormData()
    body.append('entityId', 'bafkreiexampleexampleexampleexampleexampleexampleexampleexa')
    return body
  }

  // Sends the headers and half of the body, then stalls, holding the upload in flight.
  function startStalledUpload(source: string | undefined): ClientRequest {
    const body = form()
    const buffer = body.getBuffer()
    const pending = request(`${baseUrl}/entities`, {
      method: 'POST',
      headers: {
        ...body.getHeaders(),
        'content-length': String(buffer.length),
        ...(source ? { 'cf-connecting-ip': source } : {})
      }
    })
    pending.on('error', () => undefined)
    pending.write(buffer.subarray(0, Math.floor(buffer.length / 2)))
    return pending
  }

  async function post(source: string | undefined): Promise<Response> {
    const body = form()
    const response = await fetch(`${baseUrl}/entities`, {
      method: 'POST',
      body: new Uint8Array(body.getBuffer()),
      headers: { ...body.getHeaders(), ...(source ? { 'cf-connecting-ip': source } : {}) }
    })
    // Only the status and headers are checked; release the body's connection.
    await response.body?.cancel()
    return response
  }

  // Bounded, so a route that never admits fails the assertions instead of hanging.
  async function waitForAdmissions(count: number): Promise<void> {
    const deadline = Date.now() + 3_000
    while (acquireSpy.mock.calls.length < count && Date.now() < deadline) await sleep(10)
  }

  beforeEach(async () => {
    baseUrl = `http://127.0.0.1:${await components.config.requireNumber('HTTP_SERVER_PORT')}`
    acquireSpy = jest.spyOn(components.sourceUploadLimits, 'acquire')
    stalled = [startStalledUpload(SOURCE), startStalledUpload(SOURCE)]
    await waitForAdmissions(2)
  })

  // The server frees a disconnected upload's share asynchronously; wait so it can't leak into the next test.
  async function waitForSharesReleased(): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const leases: SourceUploadLease[] = []
      try {
        // One at a time, so a lease taken before a rejection is still released.
        leases.push(components.sourceUploadLimits.acquire(SOURCE, 0))
        leases.push(components.sourceUploadLimits.acquire(SOURCE, 0))
        return
      } catch {
        await sleep(20)
      } finally {
        leases.forEach((lease) => lease.release())
      }
    }
  }

  afterEach(async () => {
    stalled.forEach((pending) => pending.destroy())
    jest.restoreAllMocks()
    await waitForSharesReleased()
  })

  describe('when a source already has its uploads in flight', () => {
    let response: Response

    beforeEach(async () => {
      response = await post(SOURCE)
    })

    it('should reject its next upload with 429 and a retry hint', () => {
      expect({ status: response.status, retryAfter: response.headers.get('retry-after') }).toEqual({
        status: 429,
        retryAfter: '5'
      })
    })
  })

  describe('when another source uploads meanwhile', () => {
    let response: Response

    beforeEach(async () => {
      response = await post(OTHER_SOURCE)
    })

    it('should admit it', () => {
      expect(response.status).not.toBe(429)
    })
  })

  describe('when requests without a client source have more uploads in flight than one share', () => {
    let response: Response

    beforeEach(async () => {
      stalled.push(startStalledUpload(undefined), startStalledUpload(undefined))
      await sleep(200)
      response = await post(undefined)
    })

    it('should not limit them per source', () => {
      expect(response.status).not.toBe(429)
    })
  })

  describe('when the same source updates world settings meanwhile', () => {
    let response: Response

    beforeEach(async () => {
      const body = new FormData()
      body.append('spawn_coordinates', '0,0')
      response = await fetch(`${baseUrl}/world/limits.dcl.eth/settings`, {
        method: 'PUT',
        body: new Uint8Array(body.getBuffer()),
        headers: { ...body.getHeaders(), 'cf-connecting-ip': SOURCE }
      })
      await response.body?.cancel()
    })

    it('should charge it to the same share and reject it with 429', () => {
      expect(response.status).toBe(429)
    })
  })

  describe('when the stalled uploads of the source disconnect', () => {
    let status: number

    beforeEach(async () => {
      stalled.forEach((pending) => pending.destroy())
      const deadline = Date.now() + 10_000
      do {
        status = (await post(SOURCE)).status
        if (status !== 429) break
        await sleep(50)
      } while (Date.now() < deadline)
    }, 15_000)

    it('should free their share for the next upload', () => {
      expect(status).not.toBe(429)
    })
  })
})
