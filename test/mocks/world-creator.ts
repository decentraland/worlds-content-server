import { AppComponents, IWorldCreator } from '../../src/types'
import { Entity, EntityType, IPFSv2 } from '@dcl/schemas'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { TextDecoder } from 'util'
import { makeid, storeJson } from '../utils'

export function createWorldCreator({
  storage,
  worldsManager
}: Pick<AppComponents, 'storage' | 'worldsManager'>): IWorldCreator {
  async function createWorldWithScene(data?: {
    worldName?: string
    metadata?: any
    files?: Map<string, ArrayBuffer>
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
    const { files, entityId } = await DeploymentBuilder.buildEntity({
      type: EntityType.SCENE as any,
      pointers: metadata.scene.parcels,
      files: data?.files || new Map(),
      metadata
    })

    const entityWithoutId = JSON.parse(new TextDecoder().decode(files.get(entityId)))
    await storeJson(storage, entityId, entityWithoutId)
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
