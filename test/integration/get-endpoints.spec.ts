import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'

test('consume content endpoints', function ({ components }) {
  it('responds /ipfs/:cid and works', async () => {
    const { localFetch, storage } = components

    {
      const r = await localFetch.fetch('/ipfs/bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y')
      expect(r.status).toEqual(404)
    }

    storage.storage.set('bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y', stringToUtf8Bytes('Hola'))

    {
      const r = await localFetch.fetch('/ipfs/bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y')
      expect(r.status).toEqual(200)
      expect(await r.text()).toEqual('Hola')
    }
  })
})

test('consume stats endpoint', function ({ components }) {
  it('responds /stats works', async () => {
    const { localFetch, storage } = components

    storage.storage.set(
      'name-some-name.dcl.eth',
      stringToUtf8Bytes(JSON.stringify({ entityId: 'bafybeictjyqjlkgybfckczpuqlqo7xfhho3jpnep4wesw3ivaeeuqugc2y' }))
    )

    const r = await localFetch.fetch('/stats')
    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      version: 'unknown',
      deployed_names: ['some-name.dcl.eth']
    })
  })
})
