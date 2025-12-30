# Multi-Scene Support for Worlds

## Overview

This document describes the multi-scene support feature that allows a single World to contain multiple independently deployed scenes. This enables teams to collaborate on shared worlds where different contributors can deploy and manage their own scenes within parcel boundaries.

## Architecture Changes

### Database Schema

#### New Table: `world_scenes`

Stores individual scene deployments within a world:

```sql
CREATE TABLE world_scenes (
  id SERIAL PRIMARY KEY,
  world_name VARCHAR NOT NULL REFERENCES worlds(name) ON DELETE CASCADE,
  entity_id VARCHAR NOT NULL,
  deployment_auth_chain JSON NOT NULL,
  entity JSON NOT NULL,
  deployer VARCHAR NOT NULL,
  parcels TEXT[] NOT NULL,
  size BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  UNIQUE(world_name, entity_id)
);
```

#### Updated Table: `worlds`

Added columns for global world configuration:

- `world_settings` (JSON): Global world configuration (minimap, skybox, etc.)
- `description` (TEXT): World description
- `thumbnail_hash` (VARCHAR): World thumbnail content hash

**Note:** The `entity_id`, `entity`, `deployment_auth_chain`, `deployer`, and `size` columns in the `worlds` table are maintained for backward compatibility but are deprecated in favor of the `world_scenes` table.

### Type Changes

#### New Types

```typescript
export type WorldScene = {
  id: string              // Entity ID
  worldName: string       // World name
  deployer: string        // Deployer address
  deploymentAuthChain: AuthChain
  entity: Entity          // Full entity data
  parcels: string[]       // Parcels occupied by this scene
  size: bigint           // Scene size in bytes
  createdAt: Date
  updatedAt: Date
}

export type WorldSettings = {
  name: string
  description?: string
  miniMapConfig?: {
    visible: boolean
    dataImage?: string
    estateImage?: string
  }
  skyboxConfig?: {
    fixedTime?: number
    textures?: string[]
  }
  fixedAdapter?: string
  thumbnailFile?: string
}
```

#### Updated Types

- `WorldMetadata` now includes a `scenes: WorldScene[]` array
- `WorldRuntimeMetadata.entityIds` is now an array of all scene entity IDs

### API Changes

#### New Endpoints

1. **GET /world/:world_name/scenes**
   - Returns all scenes deployed in a world
   - Response: `{ scenes: WorldScene[] }`

2. **GET /world/:world_name/parcels**
   - Returns all occupied parcels in a world
   - Response: `{ parcels: string[] }`

3. **DELETE /world/:world_name/scenes?parcels=0,0;0,1**
   - Undeploys scene(s) at specific parcels
   - Requires deployment permissions
   - Query parameter: `parcels` (semicolon-separated list, e.g., "0,0;0,1")

4. **GET /world/:world_name/settings**
   - Returns global world settings
   - Response: `WorldSettings`

5. **PUT /world/:world_name/settings**
   - Updates global world settings
   - Requires deployment permissions or name ownership
   - Body: `WorldSettings`

#### Updated Endpoints

1. **POST /entities**
   - Now deploys scenes to specific parcels within a world
   - If parcels are already occupied, the existing scene is replaced
   - Returns deployment confirmation with parcel information

2. **GET /world/:world_name/about**
   - Now returns multiple scene URNs in `configurations.scenesUrn`
   - Uses global world settings if configured

3. **GET /index**
   - Returns multiple scenes per world
   - Each `WorldData` contains an array of `SceneData`

## Deployment Workflow

### Standard Scene Deployment

1. **Create a scene** with the SDK as usual
2. **Deploy to a world** specifying parcels:
   ```bash
   dcl deploy --target-content https://worlds-content-server.decentraland.org
   ```
3. The scene's `pointers` field (parcels) determines which parcels it occupies
4. If those parcels are already occupied, the user is warned (but deployment proceeds, overwriting the old scene)

### Scene Pointer Format

Scenes use parcel coordinates as pointers, just like in Genesis City:
- Example: `["0,0", "0,1", "1,0", "1,1"]` for a 2x2 scene

### Permissions

- **World Owner**: Can deploy to any parcel, manage settings
- **Operators** (deployment allow-list): Can deploy to any parcel
- **Scene Deployers**: Can only overwrite their own scenes (future enhancement)

### Undeploying Scenes

Remove a scene from specific parcels:
```bash
curl -X DELETE "https://worlds-content-server.decentraland.org/world/myworld.dcl.eth/scenes?parcels=0,0;0,1" \
  -H "x-identity-auth-chain-0: ..." \
  -H "x-identity-auth-chain-1: ..." \
  -H "x-identity-timestamp: ..."
```

## World Settings Management

### Setting Global Configuration

World owners can set global configuration that applies to all scenes:

```bash
curl -X PUT "https://worlds-content-server.decentraland.org/world/myworld.dcl.eth/settings" \
  -H "Content-Type: application/json" \
  -H "x-identity-auth-chain-0: ..." \
  -d '{
    "name": "Foundation HQ",
    "description": "Decentraland Foundation Headquarters",
    "miniMapConfig": {
      "visible": true,
      "dataImage": "minimap.png",
      "estateImage": "estate.png"
    },
    "skyboxConfig": {
      "fixedTime": 36000
    }
  }'
```

### Settings Priority

1. If `world_settings` exists, it takes precedence
2. Otherwise, settings are derived from the first deployed scene (backward compatibility)

## Migration Strategy

### Automatic Migration

When the server starts, three migrations run automatically:

1. **0015_create_world_scenes_table**: Creates the `world_scenes` table
2. **0016_add_world_settings_columns**: Adds columns to `worlds` table
3. **0017_migrate_existing_scenes_to_world_scenes**: Migrates existing single-scene deployments to the new structure

### Backward Compatibility

- Existing single-scene worlds are automatically migrated to `world_scenes`
- The `worlds` table retains deprecated columns for compatibility
- API responses maintain backward compatibility (e.g., `entityId` field in metadata)
- Old deployments continue to work without changes

## Implementation Details

### Parcel Conflict Detection

When deploying a scene:
1. The system checks if any target parcels are already occupied
2. If conflicts exist, they are logged (warning only)
3. Deployment proceeds, deleting conflicting scenes
4. The CLI should present this information to the user for confirmation

### Size Calculation

- Each scene's size is calculated from its content files
- Total world size = sum of all scene sizes in `world_scenes` table
- Used for quota/limits management per wallet

### Index Generation

The `/index` endpoint:
- Returns one `WorldData` entry per world
- Each world contains an array of all its scenes
- Scenes include their actual parcels from the `world_scenes` table

### LOD (Level of Detail) Generation

- Each scene entity triggers its own LOD generation
- LOD generation is handled by downstream services (builder-server)
- Multiple entity IDs are sent via SNS notifications

## Usage Examples

### Query Available Parcels

```bash
# Get all occupied parcels in a world
curl "https://worlds-content-server.decentraland.org/world/myworld.dcl.eth/parcels"
```

Response:
```json
{
  "parcels": ["0,0", "0,1", "1,0", "1,1", "5,5"]
}
```

### List All Scenes in a World

```bash
curl "https://worlds-content-server.decentraland.org/world/myworld.dcl.eth/scenes"
```

Response:
```json
{
  "scenes": [
    {
      "id": "bafkreiabc123...",
      "worldName": "myworld.dcl.eth",
      "deployer": "0x1234...",
      "parcels": ["0,0", "0,1"],
      "size": 1048576,
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z",
      "entity": { /* full entity data */ }
    },
    {
      "id": "bafkreidef456...",
      "worldName": "myworld.dcl.eth",
      "deployer": "0x5678...",
      "parcels": ["5,5"],
      "size": 524288,
      "createdAt": "2024-01-16T14:20:00Z",
      "updatedAt": "2024-01-16T14:20:00Z",
      "entity": { /* full entity data */ }
    }
  ]
}
```

### Check World About (Multi-Scene)

```bash
curl "https://worlds-content-server.decentraland.org/world/myworld.dcl.eth/about"
```

Response now includes multiple scene URNs:
```json
{
  "configurations": {
    "scenesUrn": [
      "urn:decentraland:entity:bafkreiabc123...?=&baseUrl=https://...",
      "urn:decentraland:entity:bafkreidef456...?=&baseUrl=https://..."
    ],
    ...
  }
}
```

## Testing Recommendations

1. **Deploy Multiple Scenes**: Test deploying scenes to different parcels
2. **Conflict Testing**: Deploy to overlapping parcels and verify old scenes are replaced
3. **Permissions**: Test with different permission levels (owner, operator, unauthorized)
4. **Settings Management**: Test setting and retrieving global world settings
5. **Index Testing**: Verify `/index` returns all scenes correctly
6. **Migration Testing**: Test upgrading from single-scene to multi-scene
7. **Size Calculation**: Verify total world size is calculated correctly

## Future Enhancements

1. **Parcel-Level Permissions**: Allow specific users to deploy only to specific parcels
2. **Scene Ownership**: Track which user deployed each scene for ownership-based undeploy
3. **Scene Metadata**: Add scene-level titles, descriptions visible in the world list
4. **Visual Editor**: UI for managing scenes and parcels in a world
5. **Parcel Reservation**: Allow reserving parcels without deploying
6. **World Preview**: Generate composite preview images from all scenes

## Breaking Changes

**None.** The implementation maintains full backward compatibility:
- Existing single-scene worlds continue to work
- API responses include deprecated fields for compatibility
- Old deployments are automatically migrated

## Performance Considerations

- `world_scenes` table is indexed on `world_name` and `parcels` (GIN index for array operations)
- Fetching world metadata requires joining `worlds` and `world_scenes` tables
- Index generation loops through all worlds and their scenes (may be slower for large datasets)
- Consider caching for frequently accessed worlds

## Security Considerations

- Parcel conflicts are resolved by replacing scenes (ensure proper permissions)
- Scene undeployment requires authentication via signed fetch
- World settings updates require deployment permissions or name ownership
- Deployment permissions apply to the entire world (not parcel-specific)

