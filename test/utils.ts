import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import { Authenticator, AuthIdentity } from '@dcl/crypto'
import { Readable } from 'stream'
import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { stringToUtf8Bytes } from 'eth-connect'
import { AuthChain, EntityType } from '@dcl/schemas'
import {
  AUTH_CHAIN_HEADER_PREFIX,
  AUTH_METADATA_HEADER,
  AUTH_TIMESTAMP_HEADER
} from 'decentraland-crypto-middleware/lib/types'
import { hashV1 } from '@dcl/hashing'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { TextDecoder } from 'util'
import { DeploymentToValidate } from '../src/types'

export async function storeJson(storage: IContentStorageComponent, fileId: string, data: any) {
  const buffer = stringToUtf8Bytes(JSON.stringify(data))
  let index = 0

  return await storage.storeStream(
    fileId,
    new Readable({
      read(size) {
        const readSize = Math.min(index + size, buffer.length - index)
        if (readSize === 0) {
          this.push(null)
          return
        }
        this.push(buffer.subarray(index, readSize))
        index += readSize
      }
    })
  )
}

export async function getIdentity() {
  const ephemeralIdentity = createUnsafeIdentity()
  const realAccount = createUnsafeIdentity()

  const authChain = await Authenticator.initializeAuthChain(
    realAccount.address,
    ephemeralIdentity,
    10,
    async (message) => {
      return Authenticator.createSignature(realAccount, message)
    }
  )

  return { authChain, realAccount, ephemeralIdentity }
}

export function getAuthHeaders(
  method: string,
  path: string,
  metadata: Record<string, any>,
  chainProvider: (payload: string) => AuthChain
) {
  const headers: Record<string, string> = {}
  const timestamp = Date.now()
  const metadataJSON = JSON.stringify(metadata)
  const payloadParts = [method.toLowerCase(), path.toLowerCase(), timestamp.toString(), metadataJSON]
  const payloadToSign = payloadParts.join(':').toLowerCase()

  const chain = chainProvider(payloadToSign)

  chain.forEach((link, index) => {
    headers[`${AUTH_CHAIN_HEADER_PREFIX}${index}`] = JSON.stringify(link)
  })

  headers[AUTH_TIMESTAMP_HEADER] = timestamp.toString()
  headers[AUTH_METADATA_HEADER] = metadataJSON

  return headers
}

export async function createDeployment(identityAuthChain: AuthIdentity, entity?: any) {
  const entityFiles = new Map<string, Uint8Array>()
  entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))
  const fileHash = await hashV1(entityFiles.get('abc.txt'))

  const sceneJson = entity || {
    type: EntityType.SCENE,
    pointers: ['0,0'],
    timestamp: Date.now(),
    metadata: { runtimeVersion: '7', worldConfiguration: { name: 'whatever.dcl.eth' } },
    files: entityFiles
  }
  const { files, entityId } = await DeploymentBuilder.buildEntity(sceneJson)
  files.set(entityId, Buffer.from(files.get(entityId)))

  const authChain = Authenticator.signPayload(identityAuthChain, entityId)

  const contentHashesInStorage = new Map<string, boolean>()
  contentHashesInStorage.set(fileHash, false)

  const finalEntity = {
    id: entityId,
    ...JSON.parse(new TextDecoder().decode(files.get(entityId)))
  }

  const deployment: DeploymentToValidate = {
    entity: finalEntity,
    files,
    authChain,
    contentHashesInStorage
  }
  return deployment
}
