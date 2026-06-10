import { DeploymentFile, DeploymentToValidate, Validation, ValidationResult, ValidatorComponents } from '../../types'
import { Entity, Scene } from '@dcl/schemas'
import { createValidationResult, OK } from './utils'
import { ICoordinatesComponent } from '../coordinates'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

/** Default cap on content files per deployment, used when MAX_FILE_COUNT is unset. */
export const DEFAULT_MAX_FILE_COUNT = 10000

/**
 * Returns the canonicalized, de-duplicated parcels a deployment targets. Uses the entity
 * pointers as the source of truth — `createValidateScenePointers` guarantees they equal
 * `scene.parcels`, which is what the scene is actually placed on.
 */
function getDeploymentParcels(
  deployment: DeploymentToValidate,
  coordinates: Pick<ICoordinatesComponent, 'canonicalizeParcels'>
): string[] {
  return Array.from(new Set(coordinates.canonicalizeParcels(deployment.entity.pointers)))
}

export const validateSceneEntity: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  if (!Scene.validate(deployment.entity.metadata)) {
    return createValidationResult(Scene.validate.errors?.map((error) => error.message || '') || [])
  }

  if (!deployment.entity.metadata.worldConfiguration?.name) {
    return createValidationResult([
      'scene.json needs to specify a worldConfiguration section with a valid name inside.'
    ])
  }

  return OK
}

/**
 * Ensures the entity pointers and `scene.parcels` reference the same set of parcels, so a
 * deployment can't be authorized/sized against one set while it is placed on another.
 */
export function createValidateScenePointers(components: Pick<ValidatorComponents, 'coordinates'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const pointers = new Set(components.coordinates.canonicalizeParcels(deployment.entity.pointers))
    const sceneParcels = new Set(
      components.coordinates.canonicalizeParcels(deployment.entity.metadata?.scene?.parcels || [])
    )

    const sameParcels = pointers.size === sceneParcels.size && [...pointers].every((parcel) => sceneParcels.has(parcel))
    if (!sameParcels) {
      return createValidationResult([
        `The scene pointers [${[...pointers].join(', ')}] must match the scene parcels [${[...sceneParcels].join(
          ', '
        )}].`
      ])
    }

    return OK
  }
}

export const validateDeprecatedConfig: Validation = async (
  deployment: DeploymentToValidate
): Promise<ValidationResult> => {
  if ((deployment.entity.metadata.worldConfiguration as any)?.dclName) {
    return createValidationResult([
      '`dclName` in scene.json was renamed to `name`. Please update your scene.json accordingly.'
    ])
  }

  if (deployment.entity.metadata.worldConfiguration?.minimapVisible) {
    return createValidationResult([
      '`minimapVisible` in scene.json is deprecated in favor of `{ miniMapConfig: { visible } }`. Please update your scene.json accordingly.'
    ])
  }

  if (deployment.entity.metadata.worldConfiguration?.skybox) {
    return createValidationResult([
      '`skybox` in scene.json is deprecated in favor of `{ "skyboxConfig": { "fixedTime": 36000 }}`. Please update your scene.json accordingly.'
    ])
  }

  return OK
}

export function createValidateBannedNames(
  components: Pick<ValidatorComponents, 'nameDenyListChecker' | 'worldsManager'>
) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const worldSpecifiedName = deployment.entity.metadata.worldConfiguration.name

    // Check the name is not banned
    if (await components.nameDenyListChecker.checkNameDenyList(worldSpecifiedName)) {
      return OK
    }

    return createValidationResult([
      `Deployment failed: World "${worldSpecifiedName}" can not be deployed because the name is in the name deny list managed by Decentraland DAO.`
    ])
  }
}

/**
 * Authorizes the deployment: the signer must either own the world name or hold deployment
 * permission for every parcel being deployed.
 */
export function createValidateDeploymentPermission(
  components: Pick<ValidatorComponents, 'coordinates' | 'namePermissionChecker' | 'permissions' | 'worldsManager'>
) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const worldSpecifiedName = deployment.entity.metadata.worldConfiguration.name
    const signer = deployment.authChain[0].payload
    const parcels = getDeploymentParcels(deployment, components.coordinates)

    // The signer owns the name
    if (await components.namePermissionChecker.checkPermission(signer, worldSpecifiedName)) {
      return OK
    }

    // ...or has world-wide or parcel-specific deployment permission for those parcels
    const allowed = await components.permissions.hasPermissionForParcels(
      worldSpecifiedName,
      'deployment',
      signer,
      parcels
    )
    if (allowed) {
      return OK
    }

    return createValidationResult([
      `Deployment failed: Your wallet has no permission to publish this scene because it does not have permission to deploy under "${worldSpecifiedName}". Check scene.json to select a name that either you own or you were given permission to deploy.`
    ])
  }
}

/** Rejects scenes that occupy more parcels than the world's configured maximum. */
export function createValidateSceneDimensions(components: Pick<ValidatorComponents, 'coordinates' | 'limitsManager'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const worldName = deployment.entity.metadata.worldConfiguration.name

    const maxParcels = await components.limitsManager.getMaxAllowedParcelsFor(worldName || '')
    if (getDeploymentParcels(deployment, components.coordinates).length > maxParcels) {
      return createValidationResult([`Max allowed scene dimensions is ${maxParcels} parcels.`])
    }

    return OK
  }
}

/**
 * Validates that every parcel the deployment targets is a well-formed, in-bounds coordinate,
 * rejecting bad values here instead of letting them surface as a 500 later (e.g. when
 * computing spawn/bounding coordinates).
 */
export function createValidateParcelCoordinates(components: Pick<ValidatorComponents, 'coordinates'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const errors: string[] = []
    for (const parcel of getDeploymentParcels(deployment, components.coordinates)) {
      try {
        components.coordinates.parseCoordinate(parcel)
      } catch (error: any) {
        errors.push(error.message)
      }
    }

    return createValidationResult(errors)
  }
}

/** Rejects deployments that declare more content files than MAX_FILE_COUNT allows. */
export function createValidateFileCount(components: Pick<ValidatorComponents, 'config'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const maxFileCount = (await components.config.getNumber('MAX_FILE_COUNT')) || DEFAULT_MAX_FILE_COUNT
    const fileCount = deployment.entity.content?.length || 0
    if (fileCount > maxFileCount) {
      return createValidationResult([
        `The deployment has too many files. The maximum allowed is ${maxFileCount} but the deployment has ${fileCount}.`
      ])
    }

    return OK
  }
}

export function createValidateSize(components: Pick<ValidatorComponents, 'coordinates' | 'limitsManager' | 'storage'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const fetchContentFileSize = async (hash: string): Promise<number> => {
      const content = await components.storage.retrieve(hash)
      if (!content) {
        throw Error(`Couldn't fetch content file with hash ${hash}`)
      }

      // Empty files are retrieved with size: null in aws-sdk
      return content.size || 0
    }

    const calculateDeploymentSize = async (entity: Entity, files: Map<string, DeploymentFile>): Promise<number> => {
      let totalSize = 0
      for (const hash of new Set(entity.content?.map((item) => item.hash) ?? [])) {
        const uploadedFile = files.get(hash)
        if (uploadedFile) {
          totalSize += uploadedFile.size
        } else {
          const contentSize = await fetchContentFileSize(hash)
          totalSize += contentSize
        }
      }
      return totalSize
    }

    const worldName = deployment.entity.metadata.worldConfiguration.name
    // Pass the deployment's parcels so the quota credits back only the scenes this
    // deployment actually replaces (those overlapping these parcels), not the whole world.
    const maxTotalSizeInBytes = await components.limitsManager.getMaxAllowedSizeInBytesFor(
      worldName || '',
      getDeploymentParcels(deployment, components.coordinates)
    )

    const errors: string[] = []
    try {
      const deploymentSize = await calculateDeploymentSize(deployment.entity, deployment.files)
      if (deploymentSize > maxTotalSizeInBytes) {
        errors.push(
          `The deployment is too big. The maximum total size allowed is ${maxTotalSizeInBytes} bytes for scenes. You can upload up to ${maxTotalSizeInBytes} bytes but you tried to upload ${deploymentSize}.`
        )
      }
    } catch (e: any) {
      errors.push(e.message)
    }

    return createValidationResult(errors)
  }
}

export function createValidateSdkVersion(components: Pick<ValidatorComponents, 'limitsManager' | 'storage'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const worldName = deployment.entity.metadata.worldConfiguration.name
    const allowSdk6 = await components.limitsManager.getAllowSdk6For(worldName || '')

    const sdkVersion = deployment.entity.metadata.runtimeVersion
    if (sdkVersion !== '7' && !allowSdk6) {
      return createValidationResult([
        `Worlds are only supported on SDK 7. Please upgrade your scene to latest version of SDK.`
      ])
    }

    return OK
  }
}

export const validateMiniMapImages: Validation = async (
  deployment: DeploymentToValidate
): Promise<ValidationResult> => {
  const errors: string[] = []
  const content = deployment.entity.content || []

  for (const imageFile of [
    deployment.entity.metadata.worldConfiguration?.miniMapConfig?.dataImage,
    deployment.entity.metadata.worldConfiguration?.miniMapConfig?.estateImage
  ]) {
    if (imageFile) {
      const isFilePresent = content.some((mapping: ContentMapping) => mapping.file === imageFile)
      if (!isFilePresent) {
        errors.push(`The file ${imageFile} is not present in the entity.`)
      }
    }
  }

  return createValidationResult(errors)
}

export const validateThumbnail: Validation = async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
  const sceneThumbnail = deployment.entity.metadata?.display?.navmapThumbnail
  if (sceneThumbnail) {
    const content = deployment.entity.content || []
    const isFilePresent = content.some((content: ContentMapping) => content.file === sceneThumbnail)
    if (!isFilePresent) {
      return createValidationResult([`Scene thumbnail '${sceneThumbnail}' must be a file included in the deployment.`])
    }
  }

  return OK
}

export const validateSkyboxTextures: Validation = async (
  deployment: DeploymentToValidate
): Promise<ValidationResult> => {
  const errors: string[] = []
  const content = deployment.entity.content || []

  for (const textureFile of deployment.entity.metadata.worldConfiguration?.skyboxConfig?.textures || []) {
    if (textureFile) {
      const isFilePresent = content.some((mapping: ContentMapping) => mapping.file === textureFile)
      if (!isFilePresent) {
        errors.push(`The texture file ${textureFile} is not present in the entity.`)
      }
    }
  }

  return createValidationResult(errors)
}
