import { AppComponents, INameOwnership, IWorldCreator } from '../src/types'
import { IAuthenticatedFetchComponent } from './components/local-auth-fetch'

// components used in tests
export type TestComponents = AppComponents & {
  // A fetch component that only hits the test server with optional authentication support
  localFetch: IAuthenticatedFetchComponent
  worldCreator: IWorldCreator
  // Mocked version of nameOwnership for testing
  nameOwnership: jest.Mocked<INameOwnership>
}
