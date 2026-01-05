# Parcel Conflict Detection - Recommended Improvements

## Current Implementation

The system currently:
1. ✅ Detects parcel conflicts during validation
2. ✅ Logs warnings to server console
3. ✅ Automatically deletes conflicting scenes
4. ✅ Uses database transactions for atomicity

## Issues with Current Approach

### 1. Silent Overwrites
**Problem:** Users aren't explicitly warned that their deployment will delete existing scenes.

```typescript
// Current behavior
console.warn(`Parcels ${conflicts} will be overwritten`)
// ❌ User never sees this warning!
```

### 2. No Information About Affected Scenes
**Problem:** The validation doesn't tell the user WHAT will be deleted.

```typescript
// What we should show:
{
  conflicts: ["0,0", "0,1"],
  affectedScenes: [
    {
      entityId: "bafkrei...",
      deployer: "0x1234...",
      deployedAt: "2024-01-15T10:30:00Z",
      title: "My Awesome Scene"
    }
  ]
}
```

### 3. No Confirmation Step
**Problem:** CLI/Builder should require explicit confirmation before overwriting.

## Recommended Improvements

### Improvement 1: Return Conflict Info in Validation Response

**File:** `src/logic/validations/scene.ts`

```typescript
export function createValidateParcelConflicts(components: Pick<ValidatorComponents, 'worldsManager'>) {
  return async (deployment: DeploymentToValidate): Promise<ValidationResult> => {
    const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())
    const worldName = sceneJson.metadata.worldConfiguration.name
    const parcels = deployment.entity.pointers

    if (!parcels || parcels.length === 0) {
      return createValidationResult(['Scene must specify at least one parcel'])
    }

    try {
      const { available, conflicts } = await components.worldsManager.checkParcelsAvailable(worldName, parcels)

      if (!available && conflicts.length > 0) {
        // Get details about affected scenes
        const affectedScenes = await components.worldsManager.getScenesAtParcels(worldName, conflicts)
        
        // Create a warning with detailed information
        const warning = {
          type: 'PARCEL_CONFLICT',
          message: `Deploying to parcels [${parcels.join(', ')}] will overwrite ${affectedScenes.length} existing scene(s)`,
          conflicts,
          affectedScenes: affectedScenes.map(scene => ({
            entityId: scene.id,
            deployer: scene.deployer,
            parcels: scene.parcels,
            deployedAt: scene.createdAt,
            title: scene.entity?.metadata?.display?.title || 'Untitled Scene'
          }))
        }
        
        // Log to server
        console.warn(`[PARCEL_CONFLICT] ${warning.message}`, { worldName, warning })
        
        // Return as a validation warning (not error)
        return {
          ok: () => true,  // Still allows deployment
          errors: [],
          warnings: [warning]  // NEW: Add warnings field
        }
      }
    } catch (error: any) {
      console.warn(`Could not check parcel conflicts: ${error.message}`)
    }

    return OK
  }
}
```

### Improvement 2: Add `getScenesAtParcels` Method

**File:** `src/adapters/worlds-manager.ts`

```typescript
async function getScenesAtParcels(worldName: string, parcels: string[]): Promise<WorldScene[]> {
  if (parcels.length === 0) {
    return []
  }

  const result = await database.query<{
    id: number
    world_name: string
    entity_id: string
    deployer: string
    deployment_auth_chain: any
    entity: any
    parcels: string[]
    size: string
    created_at: Date
    updated_at: Date
  }>(SQL`
    SELECT * FROM world_scenes 
    WHERE world_name = ${worldName.toLowerCase()}
    AND parcels && ${parcels}::text[]  -- Any overlap with input parcels
    ORDER BY created_at DESC
  `)

  return result.rows.map((row) => ({
    id: row.entity_id,
    worldName: row.world_name,
    deployer: row.deployer,
    deploymentAuthChain: row.deployment_auth_chain,
    entity: row.entity,
    parcels: row.parcels,
    size: BigInt(row.size),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

// Add to return statement
return {
  // ... existing methods
  getScenesAtParcels
}
```

### Improvement 3: Update Deployment Response

**File:** `src/adapters/entity-deployer.ts`

```typescript
async function postSceneDeployment(baseUrl: string, entity: Entity, authChain: AuthLink[]) {
  const { config, metrics, snsClient } = components

  const worldName = entity.metadata.worldConfiguration.name
  const parcels = entity.pointers
  
  // Check what we're overwriting BEFORE deployment
  const { conflicts } = await worldsManager.checkParcelsAvailable(worldName, parcels)
  const overwritingScenes = conflicts.length > 0
  const affectedScenes = overwritingScenes 
    ? await worldsManager.getScenesAtParcels(worldName, conflicts)
    : []

  logger.debug(
    `Deployment for scene "${entity.id}" under world name "${worldName}" at parcels ${parcels.join(', ')}` +
    (overwritingScenes ? ` (overwriting ${affectedScenes.length} existing scene(s))` : '')
  )

  const owner = (await components.nameOwnership.findOwners([worldName])).get(worldName)

  await worldsManager.deployScene(worldName, entity, owner!, parcels)

  const kind = worldName.endsWith('dcl.eth') ? 'dcl-name' : 'ens-name'
  metrics.increment('world_deployments_counter', { kind })

  // Send SNS notification...

  const worldUrl = `${baseUrl}/world/${worldName}`
  
  // Enhanced response with overwrite information
  const message = [
    `✅ Scene deployed successfully to World "${worldName}"`,
    `📍 Parcels: ${parcels.join(', ')}`,
    overwritingScenes 
      ? `⚠️  Overwrote ${affectedScenes.length} existing scene(s):` +
        affectedScenes.map(s => `\n   - Entity: ${s.id.substring(0, 12)}... (deployed by ${s.deployer.substring(0, 10)}...)`).join('')
      : '',
    ``,
    `🌍 Access: https://play.decentraland.org/?realm=${encodeURIComponent(worldUrl)}`
  ].filter(Boolean).join('\n')

  return {
    message,
    metadata: {
      worldName,
      parcels,
      overwritingScenes,
      affectedScenes: affectedScenes.map(s => ({
        entityId: s.id,
        parcels: s.parcels
      }))
    }
  }
}
```

### Improvement 4: Add Pre-Deployment Check Endpoint

**File:** `src/controllers/handlers/scenes-handler.ts`

```typescript
export async function checkDeploymentConflictsHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/world/:world_name/check-deployment'>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  
  // Get parcels from query string
  const parcelsParam = ctx.url.searchParams.get('parcels')
  if (!parcelsParam) {
    return {
      status: 400,
      body: { error: 'Missing parcels parameter (e.g., ?parcels=0,0;0,1)' }
    }
  }

  const parcels = parcelsParam.split(';')
  
  const { available, conflicts } = await ctx.components.worldsManager.checkParcelsAvailable(
    world_name,
    parcels
  )

  if (!available) {
    const affectedScenes = await ctx.components.worldsManager.getScenesAtParcels(world_name, conflicts)
    
    return {
      status: 200,
      body: {
        canDeploy: true,  // Can still deploy, but with warnings
        conflicts: {
          hasConflicts: true,
          conflictingParcels: conflicts,
          affectedScenes: affectedScenes.map(scene => ({
            entityId: scene.id,
            deployer: scene.deployer,
            parcels: scene.parcels,
            title: scene.entity?.metadata?.display?.title || 'Untitled Scene',
            deployedAt: scene.createdAt,
            size: scene.size.toString()
          })),
          warning: `Deploying to these parcels will overwrite ${affectedScenes.length} existing scene(s)`
        }
      }
    }
  }

  return {
    status: 200,
    body: {
      canDeploy: true,
      conflicts: {
        hasConflicts: false,
        conflictingParcels: [],
        affectedScenes: []
      }
    }
  }
}
```

**Add route:**

```typescript
// In routes.ts
router.get('/world/:world_name/check-deployment', checkDeploymentConflictsHandler)
```

### Improvement 5: CLI/Builder Integration

#### CLI Usage:

```bash
# Step 1: Check for conflicts before deploying
dcl check-conflicts --target-content https://worlds-content-server.decentraland.org

# Response:
# ⚠️  WARNING: The following scene(s) will be overwritten:
#    Scene: bafkreiabc... 
#    Deployed by: 0x1234...abc
#    Parcels: 0,0, 0,1
#    Deployed at: 2024-01-15 10:30:00
#
# Continue with deployment? [y/N]

# Step 2: Deploy with confirmation
dcl deploy --target-content https://worlds-content-server.decentraland.org --force
```

#### Builder Integration:

```typescript
// Before deployment, call check endpoint
const response = await fetch(
  `https://worlds-content-server.decentraland.org/world/myworld.dcl.eth/check-deployment?parcels=0,0;0,1`
)

const { conflicts } = await response.json()

if (conflicts.hasConflicts) {
  // Show modal with affected scenes
  showWarningModal({
    title: 'Overwrite Existing Scenes?',
    message: `Deploying to these parcels will overwrite ${conflicts.affectedScenes.length} scene(s)`,
    affectedScenes: conflicts.affectedScenes,
    onConfirm: () => proceedWithDeployment(),
    onCancel: () => cancelDeployment()
  })
}
```

## Implementation Priority

### Phase 1: Server-Side (High Priority)
1. ✅ Add `getScenesAtParcels` method
2. ✅ Add `/check-deployment` endpoint
3. ✅ Enhance deployment response with overwrite info
4. ✅ Update validation to return warnings (not just errors)

### Phase 2: CLI/Builder (Medium Priority)
1. Add pre-deployment conflict check
2. Show warning dialog with affected scenes
3. Require explicit confirmation
4. Display deployment result with overwrite info

### Phase 3: UX Improvements (Low Priority)
1. Email notifications to affected scene owners
2. Audit log of overwrites
3. "Undo deployment" feature
4. Parcel reservation system

## Benefits

1. **Transparency**: Users know exactly what will be overwritten
2. **Safety**: Prevents accidental overwrites
3. **Auditability**: Clear record of what was replaced
4. **Better UX**: Clear warnings and confirmations
5. **Debugging**: Easier to diagnose conflicts

## Backward Compatibility

All improvements are backward compatible:
- Existing deployments continue to work
- Validation still returns `ok: true`
- New warning fields are optional
- New endpoint is additive (doesn't break existing flows)



