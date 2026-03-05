import { test } from '../components'
import { cleanup } from '../utils'
import FormData from 'form-data'

test('POST /entities multipart error handling', function ({ components }) {
  afterEach(async () => {
    jest.resetAllMocks()
    const { storage, database } = components
    await cleanup(storage, database)
  })

  describe('when the multipart body is truncated', () => {
    it('responds with 400', async () => {
      const { localFetch } = components
      const boundary = '----TestBoundary'
      const truncatedBody = `--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\nsome-id\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: application/octet-stream\r\n\r\nincomplete file da`
      // Body ends abruptly without closing boundary

      const response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        body: truncatedBody
      })

      expect(response.status).toBe(400)
    })
  })

  describe('when the entityId field is missing', () => {
    it('responds with 400 and "A string was expected"', async () => {
      const { localFetch } = components
      const form = new FormData()
      form.append('someOtherField', 'value')

      const response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: form.getHeaders(),
        body: form.getBuffer()
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.message).toContain('A string was expected')
    })
  })

  describe('when the content-type is not multipart/form-data', () => {
    it('responds with 400', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ entityId: 'test' })
      })

      expect(response.status).toBe(400)
    })
  })

  describe('when the multipart body is empty', () => {
    it('responds with 400', async () => {
      const { localFetch } = components
      const boundary = '----TestBoundary'
      const emptyBody = `--${boundary}--\r\n`

      const response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        body: emptyBody
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.message).toContain('A string was expected')
    })
  })
})
