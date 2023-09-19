import { keccak_256 as sha3 } from 'js-sha3'
import uts46 from 'idna-uts46-hx/dist/index'

export function hash(inputName: string) {
  // Reject empty names:
  let node = ''
  for (let i = 0; i < 32; i++) {
    node += '00'
  }

  const name = normalize(inputName)

  if (name) {
    const labels = name.split('.')

    for (let i = labels.length - 1; i >= 0; i--) {
      const labelSha = sha3(labels[i])
      node = sha3(new Buffer(node + labelSha, 'hex'))
    }
  }

  return '0x' + node
}

export function normalize(name: string) {
  return name ? uts46.toUnicode(name, { useStd3ASCII: true }) : name
}
