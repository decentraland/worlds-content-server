import { Events, WorldScenesUndeploymentEvent } from '@dcl/schemas'

export const SNS_MESSAGE_BODY_BUDGET_BYTES = 255 * 1024

export type UndeployedSceneEventSource = {
  entityId: string
  baseParcel: string
  parcels: string[]
}

export class WorldScenesUndeploymentEventTooLargeError extends Error {
  constructor(size: number, budget: number) {
    super(`World scene undeployment event identity payload is ${size} bytes, exceeding the ${budget}-byte SNS budget`)
    this.name = 'WorldScenesUndeploymentEventTooLargeError'
  }
}

/**
 * Builds an undeployment event and includes each scene footprint only while the serialized body
 * remains below the SNS budget. The reserved KiB covers the type/subType message attributes added
 * by the SNS component. Scene identities are never omitted: consumers can fetch footprints by
 * immutable entity ID when a parcel array does not fit.
 *
 * @param worldName - World whose scenes were undeployed
 * @param timestamp - Undeployment event timestamp
 * @param scenes - Scene identities and complete stored footprints
 * @param messageBodyBudgetBytes - Maximum serialized JSON body size
 * @returns The backward-compatible event and number of omitted footprints
 * @throws WorldScenesUndeploymentEventTooLargeError when scene identities alone exceed the budget
 */
export function buildWorldScenesUndeploymentEvent(
  worldName: string,
  timestamp: number,
  scenes: UndeployedSceneEventSource[],
  messageBodyBudgetBytes = SNS_MESSAGE_BODY_BUDGET_BYTES
): { event: WorldScenesUndeploymentEvent; omittedFootprints: number } {
  const event: WorldScenesUndeploymentEvent = {
    type: Events.Type.WORLD,
    subType: Events.SubType.Worlds.WORLD_SCENES_UNDEPLOYMENT,
    key: worldName,
    timestamp,
    metadata: {
      worldName,
      scenes: scenes.map(({ entityId, baseParcel }) => ({ entityId, baseParcel }))
    }
  }
  let serializedSize = Buffer.byteLength(JSON.stringify(event), 'utf8')
  if (serializedSize > messageBodyBudgetBytes) {
    throw new WorldScenesUndeploymentEventTooLargeError(serializedSize, messageBodyBudgetBytes)
  }

  let omittedFootprints = 0
  for (let index = 0; index < scenes.length; index++) {
    const parcelsPropertySize = Buffer.byteLength(`,"parcels":${JSON.stringify(scenes[index].parcels)}`, 'utf8')
    if (serializedSize + parcelsPropertySize <= messageBodyBudgetBytes) {
      event.metadata.scenes[index].parcels = scenes[index].parcels
      serializedSize += parcelsPropertySize
    } else {
      omittedFootprints++
    }
  }

  return { event, omittedFootprints }
}
