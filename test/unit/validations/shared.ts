import { Authenticator, AuthIdentity } from '@dcl/crypto'
import { stringToUtf8Bytes } from 'eth-connect'
import { hashV1 } from '@dcl/hashing'
import { EntityType } from '@dcl/schemas'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { TextDecoder } from 'util'
import { DeploymentToValidate } from '../../../src/types'

export async function createSceneDeployment(identityAuthChain: AuthIdentity, entity?: any) {
  const entityFiles = new Map<string, Uint8Array>()
  entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))
  const fileHash = await hashV1(entityFiles.get('abc.txt')!)

  const sceneJson = entity || {
    type: EntityType.SCENE,
    pointers: ['0,0'],
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
  const { files, entityId } = await DeploymentBuilder.buildEntity(sceneJson)
  files.set(entityId, Buffer.from(files.get(entityId)!))

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
