import { test } from '../components'
import { Entity } from '@dcl/schemas'
import { bufferToStream } from '@dcl/catalyst-storage'

test('consume get endpoints', function ({ components }) {
  let entity: Entity

  beforeAll(async () => {
    const { worldCreator } = components
    const created = await worldCreator.createWorldWithScene()
    entity = created.entity
  })

  it('responds /contents/:cid and works', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/contents/bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y')
    expect(r.status).toEqual(404)

    const r2 = await localFetch.fetch(`/contents/${entity.id}`)
    expect(r2.status).toEqual(200)
    expect(await r2.json()).toMatchObject({
      type: 'scene'
    })
  })

  it('responds HEAD /contents/:cid and works', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/contents/bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y', {
      method: 'HEAD'
    })
    expect(r.status).toEqual(404)

    const r2 = await localFetch.fetch(`/contents/${entity.id}`, {
      method: 'HEAD'
    })
    expect(r2.status).toEqual(200)
    expect(await r2.text()).toEqual('')
  })

  it('responds /status works', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/status')

    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject({
      content: {
        commitHash: expect.any(String),
        worldsCount: {
          dcl: expect.any(Number),
          ens: expect.any(Number)
        }
      },
      comms: {
        rooms: 1,
        users: 2
      }
    })
  })

  describe('range requests', () => {
    const contentHash = 'bafkreiahsvnr4x4rnskhkwfbnbplkbqhzb3xagdwpyfy44lgcndmhyizde'
    const contentBody = 'Hello, World! This is test content for range requests.'

    beforeEach(async () => {
      const { storage } = components
      await storage.storeStream(contentHash, bufferToStream(Buffer.from(contentBody)))
    })

    afterEach(async () => {
      const { storage } = components
      await storage.delete([contentHash])
    })

    describe('when requesting a valid byte range', () => {
      let response: Response

      beforeEach(async () => {
        const { localFetch } = components
        response = await localFetch.fetch(`/contents/${contentHash}`, {
          headers: { Range: 'bytes=0-4' }
        })
      })

      it('should respond with 206 and the partial content', async () => {
        expect(response.status).toEqual(206)
        expect(await response.text()).toEqual('Hello')
      })

      it('should include the Content-Range header', () => {
        expect(response.headers.get('content-range')).toEqual(`bytes 0-4/${contentBody.length}`)
      })

      it('should include the correct Content-Length', () => {
        expect(response.headers.get('content-length')).toEqual('5')
      })

      it('should include Accept-Ranges header', () => {
        expect(response.headers.get('accept-ranges')).toEqual('bytes')
      })
    })

    describe('when requesting a range from an offset to the end', () => {
      let response: Response

      beforeEach(async () => {
        const { localFetch } = components
        response = await localFetch.fetch(`/contents/${contentHash}`, {
          headers: { Range: 'bytes=7-' }
        })
      })

      it('should respond with 206 and the content from offset to end', async () => {
        expect(response.status).toEqual(206)
        expect(await response.text()).toEqual(contentBody.slice(7))
      })

      it('should include the Content-Range header', () => {
        expect(response.headers.get('content-range')).toEqual(`bytes 7-${contentBody.length - 1}/${contentBody.length}`)
      })
    })

    describe('when requesting a suffix range', () => {
      let response: Response

      beforeEach(async () => {
        const { localFetch } = components
        response = await localFetch.fetch(`/contents/${contentHash}`, {
          headers: { Range: 'bytes=-9' }
        })
      })

      it('should respond with 206 and the last N bytes', async () => {
        expect(response.status).toEqual(206)
        expect(await response.text()).toEqual('requests.')
      })

      it('should include the Content-Range header', () => {
        expect(response.headers.get('content-range')).toEqual(
          `bytes ${contentBody.length - 9}-${contentBody.length - 1}/${contentBody.length}`
        )
      })
    })

    describe('when requesting an out-of-bounds range', () => {
      let response: Response

      beforeEach(async () => {
        const { localFetch } = components
        response = await localFetch.fetch(`/contents/${contentHash}`, {
          headers: { Range: `bytes=${contentBody.length + 10}-` }
        })
      })

      it('should respond with 416 Range Not Satisfiable', () => {
        expect(response.status).toEqual(416)
      })

      it('should include the Content-Range header with the file size', () => {
        expect(response.headers.get('content-range')).toEqual(`bytes */${contentBody.length}`)
      })
    })

    describe('when requesting content without a Range header', () => {
      let response: Response

      beforeEach(async () => {
        const { localFetch } = components
        response = await localFetch.fetch(`/contents/${contentHash}`)
      })

      it('should respond with 200 and the full content', async () => {
        expect(response.status).toEqual(200)
        expect(await response.text()).toEqual(contentBody)
      })

      it('should include Accept-Ranges header', () => {
        expect(response.headers.get('accept-ranges')).toEqual('bytes')
      })
    })

    describe('when requesting a non-existent file with a Range header', () => {
      let response: Response

      beforeEach(async () => {
        const { localFetch } = components
        response = await localFetch.fetch('/contents/bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y', {
          headers: { Range: 'bytes=0-10' }
        })
      })

      it('should respond with 404', () => {
        expect(response.status).toEqual(404)
      })
    })

    describe('when requesting with an invalid hash and a Range header', () => {
      let response: Response

      beforeEach(async () => {
        const { localFetch } = components
        response = await localFetch.fetch('/contents/invalid-hash', {
          headers: { Range: 'bytes=0-10' }
        })
      })

      it('should respond with 400', () => {
        expect(response.status).toEqual(400)
      })
    })

    describe('when requesting with a multi-range header', () => {
      let response: Response

      beforeEach(async () => {
        const { localFetch } = components
        response = await localFetch.fetch(`/contents/${contentHash}`, {
          headers: { Range: 'bytes=0-4,7-11' }
        })
      })

      it('should fall back to 200 with the full content', async () => {
        expect(response.status).toEqual(200)
        expect(await response.text()).toEqual(contentBody)
      })
    })
  })
})
