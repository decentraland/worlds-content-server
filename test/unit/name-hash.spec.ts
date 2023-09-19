// Test results specified in original ENS Proposal:
// https://github.com/ethereum/EIPs/issues/137

import { hash, normalize } from '../../src/logic/name-hash'

describe('hash', () => {
  test('empty name', () => {
    const output = hash('')
    expect(output).toBe('0x0000000000000000000000000000000000000000000000000000000000000000')
  })

  test('TLD eth', () => {
    const output = hash('eth')
    expect(output).toBe('0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae')
  })

  test('foo.eth', () => {
    const input = 'foo.eth'
    const output = hash(input)
    expect(output).toBe('0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f')
  })
})

describe('normalize', () => {
  test('normalize ascii domain', () => {
    const input = 'foo.eth' // latin chars only
    const output = normalize(input)
    expect(output).toBe('foo.eth')
  })

  test('normalize international domain', () => {
    const input = 'fоо.eth' // with cyrillic 'o'
    const output = normalize(input)
    expect(output).toBe('fоо.eth')
  })

  test('normalize capitalized domain', () => {
    const input = 'Foo.eth' // latin chars only
    const output = normalize(input)
    expect(output).toBe('foo.eth')
  })

  test('normalize emoji domain', () => {
    const input = '🦚.eth'
    const output = normalize(input)
    expect(output).toBe('🦚.eth')
  })
})
