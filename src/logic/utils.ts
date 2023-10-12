import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { WorldMetadata } from '../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { stringToUtf8Bytes } from 'eth-connect'

export function deepEqual(a: any, b: any) {
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const count = [0, 0]
    for (const _key in a) count[0]++
    for (const _key in b) count[1]++
    if (count[0] - count[1] !== 0) {
      return false
    }
    for (const key in a) {
      if (!(key in b) || !deepEqual(a[key], b[key])) {
        return false
      }
    }
    for (const key in b) {
      if (!(key in a) || !deepEqual(b[key], a[key])) {
        return false
      }
    }
    return true
  } else {
    return a === b
  }
}

export async function readFile(storage: IContentStorageComponent, key: string): Promise<WorldMetadata | undefined> {
  const content = await storage.retrieve(key)
  if (!content) {
    return undefined
  }
  return JSON.parse((await streamToBuffer(await content.asStream())).toString()) as WorldMetadata
}

export async function writeFile(storage: IContentStorageComponent, key: string, content: object) {
  await storage.storeStream(key, bufferToStream(stringToUtf8Bytes(JSON.stringify(content))))
}
