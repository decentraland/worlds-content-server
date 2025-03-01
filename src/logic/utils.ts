import { bufferToStream, IContentStorageComponent, streamToBuffer } from '@dcl/catalyst-storage'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { WorldMetadata } from '../types'
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

export function chunks<T>(items: T[], chunkSize: number): T[][] {
  if (items.length === 0) {
    return []
  }

  return items.reduce(
    (acc: T[][], curr: T) => {
      if (acc[acc.length - 1].length === chunkSize) {
        acc.push([curr])
      } else {
        acc[acc.length - 1].push(curr)
      }
      return acc
    },
    [[]]
  )
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: {
    logger?: ILoggerComponent.ILogger
    maxRetries?: number
    baseDelay?: number
  }
): Promise<T> {
  const { logger = undefined, maxRetries = 5, baseDelay = 100 } = options || {}

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries - 1
      if (isLastAttempt) throw error

      const delay = baseDelay * Math.pow(2, attempt)
      logger?.warn('Operation failed, retrying...', {
        attempt: attempt + 1,
        delay,
        error: error?.message || 'unknown'
      })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw new Error('Should never reach this point')
}
