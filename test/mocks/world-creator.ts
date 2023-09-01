import { AppComponents, IWorldCreator } from '../../src/types'
import { Entity, EntityType, IPFSv2 } from '@dcl/schemas'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { TextDecoder } from 'util'
import { getIdentity, Identity, makeid, storeJson } from '../utils'
import { Authenticator } from '@dcl/crypto'

export function createWorldCreator({
  storage,
  worldsManager
}: Pick<AppComponents, 'storage' | 'worldsManager'>): IWorldCreator {
  async function createWorldWithScene(data?: {
    worldName?: string
    metadata?: any
    files?: Map<string, ArrayBuffer>
    identity?: Identity
  }): Promise<{ worldName: string; entityId: IPFSv2; entity: Entity }> {
    const worldName: string = data?.worldName || `w-${makeid(10)}.dcl.eth`
    const metadata = data?.metadata || {
      main: 'abc.txt',
      scene: {
        base: '20,24',
        parcels: ['20,24']
      },
      worldConfiguration: {
        name: worldName
      }
    }
    const identity = data?.identity || (await getIdentity())
    const { files, entityId } = await DeploymentBuilder.buildEntity({
      type: EntityType.SCENE as any,
      pointers: metadata.scene.parcels,
      files: data?.files || new Map(),
      metadata
    })

    const entityWithoutId = JSON.parse(new TextDecoder().decode(files.get(entityId)))
    await storeJson(storage, entityId, entityWithoutId)

    const authChain = Authenticator.signPayload(identity.authChain, entityId)
    await storeJson(storage, entityId + '.auth', authChain)

    const entity = { id: entityId, ...entityWithoutId }

    await worldsManager.deployScene(worldName, entity)

    return {
      worldName,
      entityId,
      entity
    }
  }

  function randomWorldName(): string {
    return `w-${makeid(10)}.dcl.eth`
  }

  return {
    createWorldWithScene,
    randomWorldName
  }
}
