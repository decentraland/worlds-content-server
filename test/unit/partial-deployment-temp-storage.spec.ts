import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { createPartialDeploymentTempStorage } from '../../src/adapters/partial-deployment-temp-storage'

describe('createPartialDeploymentTempStorage', () => {
  it('round-trips entityRaw under a per-entity prefix', async () => {
    const storage = createInMemoryStorage()
    const temp = createPartialDeploymentTempStorage({ storage })
    await temp.putEntityRaw('QmEntity', Buffer.from('{"x":1}'))
    const got = await temp.getEntityRaw('QmEntity')
    expect(got.toString()).toBe('{"x":1}')
  })

  it('round-trips file blobs', async () => {
    const storage = createInMemoryStorage()
    const temp = createPartialDeploymentTempStorage({ storage })
    await temp.putFile('QmEntity', 'QmA', Buffer.from([1, 2, 3]))
    const got = await temp.getFile('QmEntity', 'QmA')
    expect([...got]).toEqual([1, 2, 3])
  })

  it("keeps two deployments' files isolated by entityId", async () => {
    const storage = createInMemoryStorage()
    const temp = createPartialDeploymentTempStorage({ storage })
    await temp.putFile('QmA-deployment', 'QmFile', Buffer.from([1]))
    await temp.putFile('QmB-deployment', 'QmFile', Buffer.from([9]))
    expect([...(await temp.getFile('QmA-deployment', 'QmFile'))]).toEqual([1])
    expect([...(await temp.getFile('QmB-deployment', 'QmFile'))]).toEqual([9])
  })

  it('deleteAll removes the entity raw', async () => {
    const storage = createInMemoryStorage()
    const temp = createPartialDeploymentTempStorage({ storage })
    await temp.putEntityRaw('QmE', Buffer.from('e'))
    await temp.deleteAll('QmE')
    await expect(temp.getEntityRaw('QmE')).rejects.toThrow()
  })
})
