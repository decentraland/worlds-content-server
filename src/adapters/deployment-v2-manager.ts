import { AppComponents, DeploymentResult } from '../types'
import { AuthChain, Entity } from '@dcl/schemas'
import { hashV1 } from '@dcl/hashing'
import { InvalidRequestError } from '@dcl/platform-server-commons'

export type IDeploymentV2Manager = {
  initDeployment(
    entityId: string,
    entityRaw: Buffer,
    authChain: AuthChain,
    files: Record<string, number>
  ): Promise<OngoingDeploymentMetadata>
  addFileToDeployment(entityId: string, fileHash: string, file: Buffer): Promise<void>
  completeDeployment(baseUrl: string, entityId: string): Promise<DeploymentResult>
}

export type StartDeploymentBody = { authChain: AuthChain; files: Record<string, number> }
export type OngoingDeploymentMetadata = StartDeploymentBody & { availableFiles: string[]; missingFiles: string[] }

export function createDeploymentV2Manager(
  components: Pick<AppComponents, 'entityDeployer' | 'logs' | 'storage' | 'validator'>
): IDeploymentV2Manager {
  const { entityDeployer, logs, storage, validator } = components
  const logger = logs.getLogger('deployment-v2-manager')
  const ongoingDeploymentsRecord: Record<string, OngoingDeploymentMetadata> = {}
  const tempFiles: Record<string, Buffer> = {}

  async function initDeployment(
    entityId: string,
    entityRaw: Buffer,
    authChain: AuthChain,
    files: Record<string, number>
  ): Promise<OngoingDeploymentMetadata> {
    logger.info(`Init deployment for entity ${entityId}`)

    // Check what files are already in storage and temporary storage and return the result
    const results = Array.from((await storage.existMultiple(Object.keys(files))).entries())

    // TODO we could check the local temp folder to avoid the client uploading the same file multiple times

    const ongoingDeploymentMetadata = {
      authChain,
      files,
      availableFiles: results.filter(([_, available]) => !!available).map(([cid, _]) => cid),
      missingFiles: results.filter(([_, available]) => !available).map(([cid, _]) => cid)
    }

    // TODO we could store this in local file system of the ECS
    ongoingDeploymentsRecord[entityId] = ongoingDeploymentMetadata

    // TODO same
    tempFiles[entityId] = entityRaw

    return ongoingDeploymentMetadata
  }

  async function addFileToDeployment(entityId: string, fileHash: string, file: Buffer): Promise<void> {
    const ongoingDeploymentsRecordElement = ongoingDeploymentsRecord[entityId]
    if (!ongoingDeploymentsRecordElement) {
      throw new InvalidRequestError(`Deployment for entity ${entityId} not found`)
    }

    // TODO we could check if the ongoing deployment is too old, and reject the file

    const computedFileHash = await hashV1(file)
    if (computedFileHash === entityId || fileHash === computedFileHash) {
      if (!ongoingDeploymentsRecordElement.missingFiles.includes(fileHash)) {
        throw new InvalidRequestError(`File with hash ${fileHash} not expected in deployment for entity ${entityId}`)
      }

      const expectedSize = ongoingDeploymentsRecordElement.files[fileHash]
      if (expectedSize !== file.length) {
        throw new InvalidRequestError(
          `File with hash ${fileHash} has unexpected size in deployment for entity ${entityId}`
        )
      }
    }

    // TODO store in temp files folder
    tempFiles[fileHash] = file
    logger.info(`Received file ${fileHash} for entity ${entityId}`)
  }

  async function completeDeployment(baseUrl: string, entityId: string): Promise<DeploymentResult> {
    try {
      const ongoingDeploymentsRecordElement = ongoingDeploymentsRecord[entityId]
      if (!ongoingDeploymentsRecordElement) {
        throw new Error(`Deployment for entity ${entityId} not found`)
      }

      // TODO we could check if the ongoing deployment is too old, and reject the file (deployment TTL)

      logger.info(`Completing deployment for entity ${entityId}`)

      const authChain = ongoingDeploymentsRecordElement.authChain
      const entityRaw = tempFiles[entityId].toString()
      if (!entityRaw) {
        throw new Error(`Entity file not found in deployment for entity ${entityId}.`)
      }

      const entityMetadataJson = JSON.parse(entityRaw.toString())

      const entity: Entity = {
        id: entityId, // this is not part of the published entity
        timestamp: Date.now(), // this is not part of the published entity
        ...entityMetadataJson
      }

      const uploadedFiles: Map<string, Uint8Array> = new Map()
      for (const fileHash of Object.keys(ongoingDeploymentsRecordElement.files)) {
        if (tempFiles[fileHash]) {
          uploadedFiles.set(fileHash, tempFiles[fileHash])
        }
      }

      const contentHashesInStorage = await storage.existMultiple(
        Array.from(new Set(entity.content!.map(($) => $.hash)))
      )

      // run all validations about the deployment
      const validationResult = await validator.validate({
        entity,
        files: uploadedFiles,
        authChain,
        contentHashesInStorage
      })
      if (!validationResult.ok()) {
        throw new InvalidRequestError(`Deployment failed: ${validationResult.errors.join(', ')}`)
      }

      // Store the entity
      return await entityDeployer.deployEntity(
        baseUrl,
        entity,
        contentHashesInStorage,
        uploadedFiles,
        entityRaw,
        authChain
      )
    } finally {
      // Clean up temporary files
      const ongoingDeploymentsRecordElement = ongoingDeploymentsRecord[entityId]

      for (const fileHash in ongoingDeploymentsRecordElement.files) {
        delete tempFiles[fileHash]
      }

      // Clean up ongoing deployments
      delete ongoingDeploymentsRecord[entityId]
    }
  }

  return {
    initDeployment,
    addFileToDeployment,
    completeDeployment
  }
}
