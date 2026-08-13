import { Events, WorldSettingsChangedEvent } from '@dcl/schemas'
import { WorldSettings } from '../../types'

/**
 * Builds the settings-changed event published whenever a world's stored settings change, from either
 * a settings update or a deployment that refreshed them.
 *
 * The metadata field list is explicit on purpose: the schema forbids additional properties and
 * consumers discard events that fail validation, so `WorldSettings` must never be spread in here
 * (`settingsVersion` and `spawnCoordinates` are not part of this event).
 *
 * @param worldName - World the settings belong to
 * @param baseUrl - Public content server base URL used to build the thumbnail URL
 * @param settings - Current stored settings
 * @param timestamp - Event timestamp, also used to build the event key
 * @returns The event ready to publish
 */
export function buildWorldSettingsChangedEvent(
  worldName: string,
  baseUrl: string,
  settings: WorldSettings,
  timestamp: number
): WorldSettingsChangedEvent {
  return {
    type: Events.Type.WORLD,
    subType: Events.SubType.Worlds.WORLD_SETTINGS_CHANGED,
    key: `${worldName}-${timestamp}`,
    timestamp,
    metadata: {
      worldName,
      title: settings.title,
      description: settings.description,
      contentRating: settings.contentRating,
      skyboxTime: settings.skyboxTime,
      // Left undefined rather than defaulted to [], so consumers that apply the payload directly
      // read it as "unset" instead of "clear every category".
      categories: settings.categories ?? undefined,
      singlePlayer: settings.singlePlayer,
      showInPlaces: settings.showInPlaces,
      thumbnailUrl: settings.thumbnailHash ? `${baseUrl}/contents/${settings.thumbnailHash}` : undefined
    }
  }
}
