import { test } from '../components'
import { storeJson } from '../utils'
import { bufferToStream } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import { WorldData } from '../../src/types'

test('index handler GET /index', function ({ components }) {
  it.only('returns an error when world does not exist', async () => {
    const { localFetch, storage } = components

    const worldData1: WorldData = {
      name: 'world-name.dcl.eth',
      owner: '0x123',
      indexInPlaces: true,
      scenes: [
        {
          id: 'bafkreielwj3ki46munydwn4ayazdvmjln76khmz2xyaf5v6dkmo6yoebbi',
          title: 'Mi propia escena',
          description: 'Mi lugar en el mundo',
          thumbnail: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
          pointers: ['20,24'],
          timestamp: 1683916946483
        }
      ]
    }

    await storage.storeStream(
      'global-index.json',
      bufferToStream(Buffer.from(stringToUtf8Bytes(JSON.stringify([worldData1]))))
    )

    const r = await localFetch.fetch('/index')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      data: [
        {
          ...worldData1,
          scenes: [
            { ...worldData1.scenes[0], thumbnail: `http://0.0.0.0:3000/contents/${worldData1.scenes[0].thumbnail}` }
          ],
          currentUsers: 2
        }
      ]
    })
  })
})

test('index handler POST /index', function ({ components }) {
  it('returns an empty list of allowed when no acl exists', async () => {
    const { localFetch, storage } = components

    await storeJson(
      storage,
      'name-my-world.dcl.eth',
      '{"entityId":"bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq"}'
    )

    const r = await localFetch.fetch('/acl/my-world.dcl.eth')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resource: 'my-world.dcl.eth',
      allowed: [],
      timestamp: ''
    })
  })
})
