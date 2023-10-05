import { DeploymentToValidate, Validation, ValidationResult, ValidatorComponents } from '../../types'
import { Entity, Scene } from '@dcl/schemas'
import { createValidationResult, OK } from './utils'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'

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
    const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())
    const worldSpecifiedName = sceneJson.metadata.worldConfiguration.name

    // Check the name is not banned
    if (await components.nameDenyListChecker.checkNameDenyList(worldSpecifiedName)) {
      return OK
    }

    return createValidationResult([
      `Deployment failed: World "${worldSpecifiedName}" can not be deployed because the name is in the name deny list managed by Decentraland DAO.`
    ])
  }
}

export function createValidateDeploymentPermission(
  components: Pick<ValidatorComponents, 'namePermissionChecker' | 'worldsManager'>
) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())
    const worldSpecifiedName = sceneJson.metadata.worldConfiguration.name
    const signer = deployment.authChain[0].payload

    // Check the address owns the name
    if (await components.namePermissionChecker.checkPermission(signer, worldSpecifiedName)) {
      return OK
    }

    // Check the address has permission to deploy in the world
    const permissionChecker = await components.worldsManager.permissionCheckerForWorld(worldSpecifiedName)
    const allowed = await permissionChecker.checkPermission('deployment', signer)
    if (allowed) {
      return OK
    }

    return createValidationResult([
      `Deployment failed: Your wallet has no permission to publish this scene because it does not have permission to deploy under "${worldSpecifiedName}". Check scene.json to select a name that either you own or you were given permission to deploy.`
    ])
  }
}

export function createValidateSceneDimensions(components: Pick<ValidatorComponents, 'limitsManager'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())
    const worldName = sceneJson.metadata.worldConfiguration.name

    const maxParcels = await components.limitsManager.getMaxAllowedParcelsFor(worldName || '')
    if (deployment.entity.pointers.length > maxParcels) {
      return createValidationResult([`Max allowed scene dimensions is ${maxParcels} parcels.`])
    }

    return OK
  }
}

export function createValidateSize(components: Pick<ValidatorComponents, 'limitsManager' | 'storage'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const fetchContentFileSize = async (hash: string): Promise<number> => {
      const content = await components.storage.retrieve(hash)
      if (!content) {
        throw Error(`Couldn't fetch content file with hash ${hash}`)
      }

      // Empty files are retrieved with size: null in aws-sdk
      return content.size || 0
    }

    const calculateDeploymentSize = async (entity: Entity, files: Map<string, Uint8Array>): Promise<number> => {
      let totalSize = 0
      for (const hash of new Set(entity.content?.map((item) => item.hash) ?? [])) {
        const uploadedFile = files.get(hash)
        if (uploadedFile) {
          totalSize += uploadedFile.byteLength
        } else {
          const contentSize = await fetchContentFileSize(hash)
          totalSize += contentSize
        }
      }
      return totalSize
    }

    const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())
    const worldName = sceneJson.metadata.worldConfiguration.name
    const maxTotalSizeInBytes = await components.limitsManager.getMaxAllowedSizeInBytesFor(worldName || '')

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
    const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())
    const worldName = sceneJson.metadata.worldConfiguration.name
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
  const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())

  const errors: string[] = []

  for (const imageFile of [
    sceneJson.metadata.worldConfiguration?.miniMapConfig?.dataImage,
    sceneJson.metadata.worldConfiguration?.miniMapConfig?.estateImage
  ]) {
    if (imageFile) {
      const isFilePresent = sceneJson.content.some((content: ContentMapping) => content.file === imageFile)
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
    const isFilePresent = deployment.entity.content.some((content: ContentMapping) => content.file === sceneThumbnail)
    if (!isFilePresent) {
      return createValidationResult([`Scene thumbnail '${sceneThumbnail}' must be a file included in the deployment.`])
    }
  }

  return OK
}

export const validateSkyboxTextures: Validation = async (
  deployment: DeploymentToValidate
): Promise<ValidationResult> => {
  const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())

  const errors: string[] = []

  for (const textureFile of sceneJson.metadata.worldConfiguration?.skyboxConfig?.textures || []) {
    if (textureFile) {
      const isFilePresent = sceneJson.content.some((content: ContentMapping) => content.file === textureFile)
      if (!isFilePresent) {
        errors.push(`The texture file ${textureFile} is not present in the entity.`)
      }
    }
  }

  return createValidationResult(errors)
}
