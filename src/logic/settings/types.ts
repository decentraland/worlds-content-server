import { WorldSettings } from '../../types'

export type ISettingsComponent = {
  getWorldSettings(worldName: string): Promise<WorldSettings>
  updateWorldSettings(worldName: string, signer: string, input: WorldSettings): Promise<WorldSettings>
}
