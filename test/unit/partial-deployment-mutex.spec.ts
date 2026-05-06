import { createMutex } from '../../src/adapters/partial-deployment-mutex'

describe('createMutex', () => {
  it('serializes work for the same key', async () => {
    const mutex = createMutex()
    const order: string[] = []
    const a = mutex.run('k', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 20)); order.push('a-end'); return 'A' })
    const b = mutex.run('k', async () => { order.push('b-start'); await new Promise(r => setTimeout(r, 5)); order.push('b-end'); return 'B' })
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBe('A')
    expect(rb).toBe('B')
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('runs different keys concurrently', async () => {
    const mutex = createMutex()
    const order: string[] = []
    const a = mutex.run('x', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 20)); order.push('a-end') })
    const b = mutex.run('y', async () => { order.push('b-start'); await new Promise(r => setTimeout(r, 5)); order.push('b-end') })
    await Promise.all([a, b])
    // b finishes before a-end because they run on different keys
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end'])
  })

  it('frees the slot after a thrown error', async () => {
    const mutex = createMutex()
    await expect(mutex.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // After the error, a new run should start immediately (not hang)
    const r = await mutex.run('k', async () => 42)
    expect(r).toBe(42)
  })
})
