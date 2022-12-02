import { AuthChain, AuthLink, Entity, EthAddress, IPFSv2 } from '@dcl/schemas'
import { IHttpServerComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { FormDataContext } from '../../logic/multipart'
import { AppComponents, HandlerContextWithPath } from '../../types'
import { Authenticator } from '@dcl/crypto'
import { hashV1 } from '@dcl/hashing'
import { bufferToStream } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import {
  allowedToUseSpecifiedDclName,
  determineDclNameToUse,
  fetchNamesOwnedByAddress
} from '../../logic/check-permissions'
import { SNS } from 'aws-sdk'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'

export function requireString(val: string): string {
  if (typeof val !== 'string') throw new Error('A string was expected')
  return val
}

export function extractAuthChain(ctx: FormDataContext): AuthChain {
  const ret: AuthChain = []

  let biggestIndex = -1

  // find the biggest index
  for (const i in ctx.formData.fields) {
    const regexResult = /authChain\[(\d+)\]/.exec(i)
    if (regexResult) {
      biggestIndex = Math.max(biggestIndex, +regexResult[1])
    }
  }

  if (biggestIndex == -1) throw new Error('Missing auth chain')
  // fill all the authchain
  for (let i = 0; i <= biggestIndex; i++) {
    ret.push({
      payload: requireString(ctx.formData.fields[`authChain[${i}][payload]`].value),
      signature: requireString(ctx.formData.fields[`authChain[${i}][signature]`].value),
      type: requireString(ctx.formData.fields[`authChain[${i}][type]`].value) as any
    })
  }

  return ret
}

async function storeEntity(
  { storage }: Pick<AppComponents, 'storage'>,
  entity: Entity,
  allContentHashesInStorage: Map<string, boolean>,
  logger: ILoggerComponent.ILogger,
  files: Map<string, Uint8Array>,
  entityJson: string,
  authChain: AuthLink[],
  deploymentDclName: string
) {
  // store all files
  for (const file of entity.content!) {
    if (!allContentHashesInStorage.get(file.hash)) {
      const filename = entity.content!.find(($) => $.hash == file.hash)
      logger.info(`Storing file`, { cid: file.hash, filename: filename?.file || 'unknown' })
      await storage.storeStream(file.hash, bufferToStream(files.get(file.hash)!))
      allContentHashesInStorage.set(file.hash, true)
    }
  }

  // TODO Read already existing entity (if any) and remove all its files (to avoid leaving orphaned files)

  logger.info(`Storing entity`, { cid: entity.id })
  await storage.storeStream(entity.id, bufferToStream(stringToUtf8Bytes(entityJson)))
  await storage.storeStream(entity.id + '.auth', bufferToStream(stringToUtf8Bytes(JSON.stringify(authChain))))
  await storage.storeStream(
    `name-${deploymentDclName.toLowerCase()}.dcl.eth`,
    bufferToStream(stringToUtf8Bytes(JSON.stringify({ entityId: entity.id })))
  )
}

export async function deployEntity(
  ctx: FormDataContext &
    HandlerContextWithPath<
      'config' | 'ethereumProvider' | 'logs' | 'marketplaceSubGraph' | 'metrics' | 'storage' | 'sns' | 'validator',
      '/entities'
    >
): Promise<IHttpServerComponent.IResponse> {
  const logger = ctx.components.logs.getLogger('deploy')
  const sns = new SNS()

  const Error400 = (message: string) => {
    logger.warn(message)
    return {
      status: 400,
      body: message
    }
  }

  try {
    const entityId = requireString(ctx.formData.fields.entityId.value)
    const authChain = extractAuthChain(ctx)

    const validationResult2 = await ctx.components.validator.validateAuthChain(authChain)
    if (!validationResult2.ok()) {
      return Error400(`Deployment failed: Invalid auth chain: ${validationResult2.errors.join(', ')}`)
    }

    const signer = authChain[0].payload
    const validationResult3 = await ctx.components.validator.validateSigner(signer)
    if (!validationResult3.ok()) {
      return Error400(`Deployment failed: Invalid auth chain: ${validationResult3.errors.join(', ')}`)
    }

    const validationResult4 = await ctx.components.validator.validateSignature(entityId, authChain, 10)
    if (!validationResult4.ok()) {
      return Error400(`Deployment failed: Invalid auth chain: ${validationResult4.errors.join(', ')}`)
    }

    // validate that the signer has permissions to deploy this scene. TheGraph only responds to lower cased addresses
    const names = await fetchNamesOwnedByAddress(ctx.components, signer.toLowerCase())
    const hasPermission = names.length > 0
    if (!hasPermission) {
      return Error400(
        `Deployment failed: Your wallet has no permission to publish to this server because it doesn't own a Decentraland NAME.`
      )
    }

    const sceneJson = JSON.parse(ctx.formData.files[entityId].value.toString())
    if (!allowedToUseSpecifiedDclName(names, sceneJson)) {
      return Error400(
        `Deployment failed: Your wallet has no permission to publish to this server because it doesn't own Decentraland NAME "${sceneJson.metadata.worldConfiguration?.dclName}". Check scene.json to select a different name.`
      )
    }

    // determine the name to use for deploying the world
    const deploymentDclName = determineDclNameToUse(names, sceneJson)

    logger.debug(`Deployment for scene "${entityId}" under dcl name "${deploymentDclName}.dcl.eth"`)

    // then validate that the entityId is valid
    const entityRaw = ctx.formData.files[entityId].value.toString()
    if ((await hashV1(stringToUtf8Bytes(entityRaw))) != entityId) {
      return Error400('Deployment failed: Invalid entity hash')
    }
    // then validate that the entity is valid
    const entity: Entity = {
      id: entityId, // this is not part of the published entity
      timestamp: Date.now(), // this is not part of the published entity
      ...JSON.parse(entityRaw)
    }
    const validationResult1 = await ctx.components.validator.validateEntity(entity)
    if (!validationResult1.ok()) {
      return Error400(`Deployment failed: Invalid entity schema: ${validationResult1.errors.join(', ')}`)
    }

    // then validate all files are part of the entity
    for (const hash in ctx.formData.files) {
      // detect extra file
      if (!entity.content!.some(($) => $.hash == hash) && hash !== entityId) {
        return Error400(`Deployment failed: Extra file detected ${hash}`)
      }
      // only new hashes
      if (!IPFSv2.validate(hash)) {
        return Error400('Deployment failed: Only CIDv1 are allowed for content files')
      }
      // hash the file
      if ((await hashV1(ctx.formData.files[hash].value)) !== hash) {
        return Error400("Deployment failed: The hashed file doesn't match the provided content")
      }
    }

    const allContentHashes = Array.from(new Set(entity.content!.map(($) => $.hash)))
    const allContentHashesInStorage = await ctx.components.storage.existMultiple(allContentHashes)

    // then ensure that all missing files are uploaded
    for (const file of entity.content!) {
      const isFilePresent = ctx.formData.files[file.hash] || allContentHashesInStorage.get(file.hash)
      if (!isFilePresent) {
        return Error400(
          `Deployment failed: The file ${file.hash} (${file.file}) is neither present in the storage or in the provided entity`
        )
      }
    }

    // TODO: run proper validations

    const theFiles: Map<string, Uint8Array> = new Map()
    for (const filesKey in ctx.formData.files) {
      theFiles.set(filesKey, ctx.formData.files[filesKey].value)
    }

    const validationResult = await ctx.components.validator.validateSize(entity, theFiles)
    if (!validationResult.ok()) {
      return Error400(`Deployment failed: ${validationResult.errors.join(', ')}`)
    }

    // Store the entity
    await storeEntity(
      ctx.components,
      entity,
      allContentHashesInStorage,
      logger,
      theFiles,
      entityRaw,
      authChain,
      deploymentDclName
    )

    const baseUrl = ((await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`).toString()

    ctx.components.metrics.increment('world_deployments_counter')

    // send deployment notification over sns
    if (ctx.components.sns.arn) {
      const deploymentToSqs: DeploymentToSqs = {
        entity: {
          entityId: entityId,
          authChain
        },
        contentServerUrls: [baseUrl]
      }
      const receipt = await sns
        .publish({
          TopicArn: ctx.components.sns.arn,
          Message: JSON.stringify(deploymentToSqs)
        })
        .promise()
      logger.info('notification sent', {
        MessageId: receipt.MessageId as any,
        SequenceNumber: receipt.SequenceNumber as any
      })
    }

    const worldUrl = `${baseUrl}/world/${deploymentDclName}.dcl.eth`
    const urn = `urn:decentraland:entity:${entityId}?baseUrl=${baseUrl}/ipfs`

    return {
      status: 200,
      body: {
        creationTimestamp: Date.now(),
        message: [
          `Your entity was deployed to a custom content server!`,
          `The URN for your entity is:\n  ${urn}`,
          ``,
          `You can preview it as a portable experience using this link: https://play.decentraland.org/?GLOBAL_PX=${encodeURIComponent(
            urn
          )}`,
          ``,
          `Preview as Space: https://play.decentraland.zone/?SPACE=${encodeURIComponent(urn)}`,
          `Preview as World: https://play.decentraland.zone/?realm=${encodeURIComponent(worldUrl)}`
        ].join('\n')
      }
    }
  } catch (err: any) {
    console.error(err)
    logger.error(err)
    throw err
  }
}
