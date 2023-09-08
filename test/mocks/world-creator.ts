import { AppComponents, IWorldCreator, Permissions } from '../../src/types'
import { Entity, EntityType, IPFSv2 } from '@dcl/schemas'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { TextDecoder } from 'util'
import { getIdentity, makeid, storeJson } from '../utils'
import { Authenticator, AuthIdentity } from '@dcl/crypto'
import { defaultPermissions } from '../../src/logic/permissions-checker'

export function createWorldCreator({
  storage,
  worldsManager
}: Pick<AppComponents, 'storage' | 'worldsManager'>): IWorldCreator {
  async function createWorldWithScene(data?: {
    worldName?: string
    metadata?: any
    files?: Map<string, ArrayBuffer>
    permissions?: Permissions
    owner?: AuthIdentity
  }): Promise<{ worldName: string; entityId: IPFSv2; entity: Entity; owner: AuthIdentity }> {
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

    const signer = data?.owner || (await getIdentity())?.authChain
    const { files, entityId } = await DeploymentBuilder.buildEntity({
      type: EntityType.SCENE as any,
      pointers: metadata.scene.parcels,
      files: data?.files || new Map(),
      metadata
    })
    const permissions = data?.permissions || defaultPermissions()

    const entityWithoutId = JSON.parse(new TextDecoder().decode(files.get(entityId)))
    await storeJson(storage, entityId, entityWithoutId)

    const authChain = Authenticator.signPayload(signer, entityId)
    await storeJson(storage, entityId + '.auth', authChain)

    const entity = { id: entityId, ...entityWithoutId }

    await worldsManager.deployScene(worldName, entity)
    await worldsManager.storePermissions(worldName, permissions)

    return {
      worldName,
      entityId,
      entity,
      owner: signer
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
