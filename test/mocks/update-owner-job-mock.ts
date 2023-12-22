import { AppComponents, IRunnable } from '../../src/types'

export async function createMockUpdateOwnerJob(_components: Partial<AppComponents>): Promise<IRunnable<void>> {
  return {
    run: () => Promise.resolve(),
    start: () => Promise.resolve()
  }
}
