import { Entity } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { IHttpServerComponent } from '@dcl/core-commons'
import { FormDataContext, readUploadedFile, toDeploymentFile } from '../../logic/multipart'
import { DeploymentFile, HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'
import { InvalidRequestError, NotAuthorizedError } from '@dcl/http-commons'

export function requireString(val: string | null | undefined): string {
  if (typeof val !== 'string') throw new InvalidRequestError('A string was expected')
  return val
}

function parseEntityJson(raw: string) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new InvalidRequestError('The entity file is not valid JSON.')
  }
}

export async function deployEntity(
  ctx: FormDataContext &
    HandlerContextWithPath<
      | 'config'
      | 'entityDeployer'
      | 'logs'
      | 'namePermissionChecker'
      | 'permissions'
      | 'storage'
      | 'validator'
      | 'worlds',
      '/entities'
    >
): Promise<IHttpServerComponent.IResponse> {
  const entityId = requireString(ctx.formData.fields.entityId?.value[0])
  const authChain = extractAuthChain(ctx)

  const entityFile = ctx.formData.files[entityId]
  if (!entityFile) {
    throw new InvalidRequestError(`Entity file "${entityId}" is missing from the request.`)
  }

  // The entity JSON is small, so it is safe to read fully into memory.
  const entityRaw = (await readUploadedFile(entityFile)).toString()
  const entityMetadataJson = parseEntityJson(entityRaw)

  const entity: Entity = {
    id: entityId,
    ...entityMetadataJson
  }

  const uploadedFiles: Map<string, DeploymentFile> = new Map()
  for (const filesKey in ctx.formData.files) {
    uploadedFiles.set(filesKey, toDeploymentFile(ctx.formData.files[filesKey]))
  }

  const contentHashesInStorage = await ctx.components.storage.existMultiple(
    Array.from(new Set((entity.content || []).map(($) => $.hash)))
  )

  // run all validations about the deployment
  const validationResult = await ctx.components.validator.validate({
    entity,
    files: uploadedFiles,
    authChain,
    contentHashesInStorage
  })

  if (!validationResult.ok()) {
    throw new InvalidRequestError(`Deployment failed: ${validationResult.errors.join(', ')}`)
  }

  // Single-scene deploy: replace the whole world with just this scene, removing any OTHER scenes after
  // it lands. Unlike a world-wide undeploy this never empties the world, so its place (and any env
  // variables bound to the place) is preserved across the redeploy. See undeployOtherWorldScenes.
  //
  // It removes scenes beyond the parcels being deployed, so it requires authority over the whole world —
  // not just those parcels. Gate it up front (fail fast, before the deploy commits) on world ownership
  // or world-wide deployment permission, mirroring the world-wide undeploy endpoint, so a per-parcel
  // grantee cannot wipe scenes outside its grant.
  const singleWorldScene = ctx.url.searchParams.get('single_world_scene') === 'true'
  const worldName: string | undefined = entity.metadata?.worldConfiguration?.name
  const baseParcel: string | undefined = entity.metadata?.scene?.base ?? entity.pointers?.[0]
  if (singleWorldScene && worldName) {
    const deployer = Authenticator.ownerAddress(authChain)
    const isOwner = await ctx.components.namePermissionChecker.checkPermission(deployer, worldName)
    const authorized =
      isOwner || (await ctx.components.permissions.hasWorldWidePermission(worldName, 'deployment', deployer))
    if (!authorized) {
      throw new NotAuthorizedError(
        'The singleWorldScene option requires world ownership or world-wide deployment permission.'
      )
    }
  }

  // Store the entity
  const baseUrl = (await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`
  const message = await ctx.components.entityDeployer.deployEntity(
    baseUrl,
    entity,
    contentHashesInStorage,
    uploadedFiles,
    entityRaw,
    authChain
  )

  // Single-scene deploy: now that this scene is live, remove every OTHER scene in the world so only
  // this one remains. Best-effort — the deploy is already committed, and because this publishes a
  // WorldScenesUndeploymentEvent (never a WorldUndeploymentEvent) the world's place is preserved
  // regardless, so a failure here just leaves stale scenes; it must not turn a successful deploy into a 5xx.
  if (singleWorldScene && worldName && baseParcel) {
    try {
      await ctx.components.worlds.undeployOtherWorldScenes(worldName, baseParcel)
    } catch (error) {
      ctx.components.logs
        .getLogger('deploy-entity')
        .warn(`singleWorldScene: failed to undeploy other scenes for world "${worldName}": ${error}`, { entityId })
    }
  }

  return {
    status: 200,
    body: {
      creationTimestamp: Date.now(),
      ...message
    }
  }
}
