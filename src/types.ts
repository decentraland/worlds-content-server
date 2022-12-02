import type { IFetchComponent } from '@well-known-components/http-server'
import type {
  IConfigComponent,
  ILoggerComponent,
  IHttpServerComponent,
  IBaseComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import { metricDeclarations } from './metrics'
import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { MockedStorage } from '@dcl/catalyst-storage/dist/MockedStorage'
import { HTTPProvider } from 'eth-connect'
import { ISubgraphComponent } from '@well-known-components/thegraph-component'
import { IStatusComponent } from './adapters/status'
import { AuthChain, Entity } from '@dcl/schemas'

export type GlobalContext = {
  components: BaseComponents
}

export type DeploymentToValidate = {
  entity: Entity
  files: Map<string, Uint8Array>
  authChain: AuthChain
  contentHashesInStorage: Map<string, boolean>
}

export interface Validator {
  validate(deployment: DeploymentToValidate): Promise<ValidationResult>
}

export type ValidationResult = {
  ok: () => boolean
  errors: string[]
}

export type Validation = {
  validate: (
    components: Pick<AppComponents, 'config' | 'ethereumProvider' | 'storage'>,
    deployment: DeploymentToValidate
  ) => ValidationResult | Promise<ValidationResult>
}

export type Validator2 = {
  validateDeployment: (
    entity: Entity,
    entityRaw: string,
    authChain: AuthChain,
    uploadedFiles: Map<string, Uint8Array>,
    contentHashesInStorage: Map<string, boolean>
  ) => Promise<ValidationResult>
  validateFiles: (
    entity: Entity,
    uploadedFiles: Map<string, Uint8Array>,
    contentHashesInStorage: Map<string, boolean>
  ) => Promise<ValidationResult>
  validateEntityId: (entityId: string, entityRaw: string) => Promise<ValidationResult>
  validateEntity: (entity: Entity) => ValidationResult
  validateAuthChain: (authChain: AuthChain) => ValidationResult
  validateSignature: (
    entityId: string,
    authChain: AuthChain,
    dateToValidateExpirationInMillis?: number
  ) => Promise<ValidationResult>
  validateSigner: (signer: string) => ValidationResult
  validateSize: (entity: Entity, uploadedFiles: Map<string, Uint8Array>) => Promise<ValidationResult>
}

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IHttpServerComponent<GlobalContext>
  fetch: IFetchComponent
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  ethereumProvider: HTTPProvider
  storage: IContentStorageComponent
  marketplaceSubGraph: ISubgraphComponent
  status: IStatusComponent
  sns: SnsComponent
  validator: Validator
}

export type SnsComponent = { arn?: string }

// components used in runtime
export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent
}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
  storage: MockedStorage
}

// this type simplifies the typings of http handlers
export type HandlerContextWithPath<
  ComponentNames extends keyof AppComponents,
  Path extends string = any
> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{
    components: Pick<AppComponents, ComponentNames>
  }>,
  Path
>

export type Context<Path extends string = any> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>
