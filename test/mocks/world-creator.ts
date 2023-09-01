import { AppComponents, IWorldCreator } from '../../src/types'
import { Entity, EntityType, IPFSv2 } from '@dcl/schemas'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { TextDecoder } from 'util'
import { makeid, storeJson } from '../utils'

export function createWorldCreator({
  storage,
  worldsManager
}: Pick<AppComponents, 'storage' | 'worldsManager'>): IWorldCreator {
  async function createWorldWithScene(
    worldName: string = `w-${makeid(10)}.dcl.eth`
  ): Promise<{ worldName: string; entityId: IPFSv2; entity: Entity }> {
    const { files, entityId } = await DeploymentBuilder.buildEntity({
      type: EntityType.SCENE as any,
      pointers: ['0,0'],
      files: new Map(),
      metadata: {
        main: 'abc.txt',
        scene: {
          base: '20,24',
          parcels: ['20,24']
        },
        worldConfiguration: {
          name: worldName
        }
      }
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
