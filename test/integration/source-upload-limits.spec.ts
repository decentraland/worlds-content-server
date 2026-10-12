import FormData from 'form-data'
import { ClientRequest, request } from 'http'
import { setTimeout as sleep } from 'timers/promises'
import { test } from '../components'
import { SourceUploadLease } from '../../src/adapters/source-upload-limits'

// Runs at module evaluation, before the harness initializes components; process.env wins over .env.default.
process.env.MAX_CONCURRENT_UPLOADS_PER_SOURCE = '2'

const SOURCE = '203.0.113.10'
const OTHER_SOURCE = '203.0.113.11'

type PostResult = { status: number; retryAfter: string | null; body: unknown }

const THROTTLED = {
  status: 429,
  retryAfter: '5',
  body: { error: 'Too Many Requests', message: 'Too many uploads in progress from this client, please retry shortly.' }
}

// An admitted form carrying only an entity id is rejected by the deploy handler itself.
const ADMITTED = {
  status: 400,
  retryAfter: null,
  body: expect.objectContaining({ message: 'Missing auth chain' })
}

test('Per-source in-flight upload limits on POST /entities', function ({ components }) {
  let baseUrl: string
  let stalled: ClientRequest[]
  let acquireSpy: jest.SpyInstance
  let incrementSpy: jest.SpyInstance

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

  async function post(source: string | undefined): Promise<PostResult> {
    const body = form()
    const response = await fetch(`${baseUrl}/entities`, {
      method: 'POST',
      body: new Uint8Array(body.getBuffer()),
      headers: { ...body.getHeaders(), ...(source ? { 'cf-connecting-ip': source } : {}) }
    })
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() }
  }

  // Bounded, so a route that never admits fails loudly instead of hanging.
  async function waitUntil(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`)
      await sleep(10)
    }
  }

  function unattributedAdmissions(): number {
    return incrementSpy.mock.calls.filter(([name]) => name === 'multipart_upload_unattributed').length
  }

  beforeEach(async () => {
    baseUrl = `http://127.0.0.1:${await components.config.requireNumber('HTTP_SERVER_PORT')}`
    acquireSpy = jest.spyOn(components.sourceUploadLimits, 'acquire')
    incrementSpy = jest.spyOn(components.metrics, 'increment')
    stalled = [startStalledUpload(SOURCE), startStalledUpload(SOURCE)]
    await waitUntil(() => acquireSpy.mock.calls.length >= 2, 'the stalled uploads to be admitted')
  })

  // The server frees a disconnected upload's share asynchronously; wait so it can't leak into the next test.
  async function waitForSharesReleased(): Promise<void> {
    await waitUntil(
      () => {
        const leases: SourceUploadLease[] = []
        try {
          // One at a time, so a lease taken before a rejection is still released.
          leases.push(components.sourceUploadLimits.acquire(SOURCE, 0))
          leases.push(components.sourceUploadLimits.acquire(SOURCE, 0))
          return true
        } catch {
          return false
        } finally {
          leases.forEach((lease) => lease.release())
        }
      },
      'the source share to be released',
      5_000
    )
  }

  afterEach(async () => {
    stalled.forEach((pending) => pending.destroy())
    jest.restoreAllMocks()
    await waitForSharesReleased()
  })

  describe('when a source already has its uploads in flight', () => {
    let result: PostResult

    beforeEach(async () => {
      result = await post(SOURCE)
    })

    it('should reject its next upload with 429, a retry hint and the throttling message', () => {
      expect(result).toEqual(THROTTLED)
    })
  })

  describe('when another source uploads meanwhile', () => {
    let result: PostResult

    beforeEach(async () => {
      result = await post(OTHER_SOURCE)
    })

    it('should admit it to the deploy handler', () => {
      expect(result).toEqual(ADMITTED)
    })
  })

  describe('when requests without a client source have more uploads in flight than one share', () => {
    let result: PostResult

    beforeEach(async () => {
      stalled.push(startStalledUpload(undefined), startStalledUpload(undefined))
      await waitUntil(() => unattributedAdmissions() >= 2, 'the unattributed stalled uploads to be admitted')
      result = await post(undefined)
    })

    it('should not limit them per source', () => {
      expect(result).toEqual(ADMITTED)
    })
  })

  describe('when the same source updates world settings meanwhile', () => {
    let result: PostResult

    beforeEach(async () => {
      const body = new FormData()
      body.append('spawn_coordinates', '0,0')
      const response = await fetch(`${baseUrl}/world/limits.dcl.eth/settings`, {
        method: 'PUT',
        body: new Uint8Array(body.getBuffer()),
        headers: { ...body.getHeaders(), 'cf-connecting-ip': SOURCE }
      })
      result = { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() }
    })

    it('should charge it to the same share and reject it with 429', () => {
      expect(result).toEqual(THROTTLED)
    })
  })

  describe('when the stalled uploads of the source disconnect', () => {
    let result: PostResult

    beforeEach(async () => {
      stalled.forEach((pending) => pending.destroy())
      const deadline = Date.now() + 10_000
      do {
        result = await post(SOURCE)
        if (result.status !== 429) break
        await sleep(50)
      } while (Date.now() < deadline)
    }, 15_000)

    it('should free their share for the next upload', () => {
      expect(result).toEqual(ADMITTED)
    })
  })
})
