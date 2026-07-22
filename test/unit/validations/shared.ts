import { Authenticator, AuthIdentity } from '@dcl/crypto'
import { stringToUtf8Bytes } from 'eth-connect'
import { hashV1 } from '@dcl/hashing'
import { EntityType } from '@dcl/schemas'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { TextDecoder } from 'util'
import { Readable } from 'stream'
import { DeploymentFile, DeploymentToValidate } from '../../../src/types'

/** Wraps an in-memory buffer as a DeploymentFile for unit tests (no temp files needed). */
export function bufferToDeploymentFile(content: Uint8Array): DeploymentFile {
  const buffer = Buffer.from(content)
  return {
    size: buffer.byteLength,
    getStream: () => Readable.from(buffer),
    getHash: () => hashV1(buffer),
    asBuffer: async () => buffer
  }
}

export async function createSceneDeployment(identityAuthChain: AuthIdentity, entity?: any) {
  const entityFiles = new Map<string, Uint8Array>()
  entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))
  const fileHash = await hashV1(entityFiles.get('abc.txt')!)

  const sceneJson = entity || {
    type: EntityType.SCENE,
    pointers: ['20,24'],
    timestamp: Date.now(),
    metadata: {
      main: 'abc.txt',
      scene: {
        base: '20,24',
        parcels: ['20,24']
      },
      runtimeVersion: '7',
      worldConfiguration: { name: 'whatever.dcl.eth' },
      display: {
        navmapThumbnail: 'abc.txt'
      }
    },
    files: entityFiles
  }
  const { files: builtFiles, entityId } = await DeploymentBuilder.buildEntity(sceneJson)
  builtFiles.set(entityId, Buffer.from(builtFiles.get(entityId)!))

  const authChain = Authenticator.signPayload(identityAuthChain, entityId)

  const contentHashesInStorage = new Map<string, boolean>()
  contentHashesInStorage.set(fileHash, false)

  const finalEntity = {
    id: entityId,
    ...JSON.parse(new TextDecoder().decode(builtFiles.get(entityId)))
  }

  const files = new Map<string, DeploymentFile>()
  for (const [name, content] of builtFiles) {
    files.set(name, bufferToDeploymentFile(content))
  }

  const deployment: DeploymentToValidate = {
    entity: finalEntity,
    files,
    authChain,
    contentHashesInStorage
  }
  return deployment
}
