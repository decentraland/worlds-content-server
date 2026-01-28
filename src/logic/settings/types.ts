import { WorldSettings, WorldSettingsInput } from '../../types'

export type ISettingsComponent = {
  getWorldSettings(worldName: string): Promise<WorldSettings>
  updateWorldSettings(worldName: string, signer: string, input: WorldSettingsInput): Promise<WorldSettings>
}
