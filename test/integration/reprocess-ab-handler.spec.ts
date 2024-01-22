import { test } from '../components'
import { stringToUtf8Bytes } from 'eth-connect'

test('reprocess asset-bundles handler /reprocess-ab', function ({ components, stubComponents }) {
  beforeEach(async () => {
    const { config } = stubComponents
    config.getString.withArgs('SNS_ARN').resolves('some-arn')
  })

  it('when world exists it responds', async () => {
    const { localFetch, worldCreator } = components

    const files = new Map<string, Uint8Array>()
    files.set('abc.png', Buffer.from(stringToUtf8Bytes('Hello world')))

    const { entityId, worldName, entity } = await worldCreator.createWorldWithScene({})

    const r = await localFetch
      .fetch(`/reprocess-ab`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer setup_some_secret_here'
        }
      })
      .catch(console.error)

    // console.log(r.status, r.statusText)
    // expect(r.status).toEqual(200)
    // expect(await r.json()).toEqual({
    //   name: worldName
    // })
  })
})
