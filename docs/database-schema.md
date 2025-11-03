# Database Schema Documentation

This document describes the database schema for the Worlds Content Server. The schema uses PostgreSQL and is managed through migrations located in `src/migrations/`.

## Tables Overview

The database contains two main tables:
1. **`worlds`** - Stores world/scene deployment information
2. **`blocked`** - Stores blocked wallet addresses
3. **`migrations`** - Tracks executed database migrations (internal)

---

## Table: `worlds`

Stores all deployed worlds (scenes identified by DCL names) and their associated metadata, permissions, and entity data.

### Schema

```sql
CREATE TABLE worlds
(
    name VARCHAR NOT NULL PRIMARY KEY,
    deployer VARCHAR,
    entity_id VARCHAR,
    deployment_auth_chain JSON,
    entity JSON,
    permissions JSON NOT NULL,
    size BIGINT,
    owner VARCHAR,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE INDEX worlds_deployer_index ON worlds (deployer);
```

### Columns

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `name` | VARCHAR | NOT NULL | **Primary Key**. World name (DCL name, e.g., `"myworld.dcl.eth"`). Stored in lowercase. |
| `deployer` | VARCHAR | NULL | Ethereum address of the wallet that deployed the world. Used for indexing. |
| `entity_id` | VARCHAR | NULL | IPFS hash (CID) of the deployed entity. Null if world exists but has no deployment. |
| `deployment_auth_chain` | JSON | NULL | Authentication chain used for deployment. Array of `AuthLink` objects following ADR-44. |
| `entity` | JSON | NULL | Full entity JSON object containing scene metadata, content mappings, and all entity data. |
| `permissions` | JSON | **NOT NULL** | Permissions configuration object. See [Permissions Structure](#permissions-structure) below. |
| `size` | BIGINT | NULL | Total size of all world content files in bytes. Calculated from entity content hashes. |
| `owner` | VARCHAR | NULL | Ethereum address of the DCL name owner (verified via blockchain). |
| `created_at` | TIMESTAMP | NOT NULL | Timestamp when the world record was first created. |
| `updated_at` | TIMESTAMP | NOT NULL | Timestamp when the world record was last updated. |

### Indexes

- **Primary Key**: `name`
- **Index**: `worlds_deployer_index` on `deployer` column

### Permissions Structure

The `permissions` column stores a JSON object with the following structure:

```typescript
type Permissions = {
  deployment: AllowListPermissionSetting  // Who can deploy/update the world
  access: AccessPermissionSetting         // Who can access/visit the world
  streaming: UnrestrictedPermissionSetting | AllowListPermissionSetting  // Who can stream to the world
}
```

#### Permission Types

1. **`deployment`** (Always AllowList)
   ```json
   {
     "type": "allow-list",
     "wallets": ["0x...", "0x..."]  // Array of lowercase Ethereum addresses
   }
   ```

2. **`access`** (One of: Unrestricted, AllowList, SharedSecret, NFTOwnership)
   ```json
   // Unrestricted
   {
     "type": "unrestricted"
   }
   
   // AllowList
   {
     "type": "allow-list",
     "wallets": ["0x...", "0x..."]
   }
   
   // SharedSecret
   {
     "type": "shared-secret",
     "secret": "bcrypt-hashed-secret"
   }
   
   // NFTOwnership
   {
     "type": "nft-ownership",
     "nft": "urn:decentraland:matic:collections-v2:0x...:1"
   }
   ```

3. **`streaming`** (Unrestricted or AllowList only)
   ```json
   // Unrestricted
   {
     "type": "unrestricted"
   }
   
   // AllowList
   {
     "type": "allow-list",
     "wallets": ["0x...", "0x..."]
   }
   ```

#### Default Permissions

```json
{
  "deployment": {
    "type": "allow-list",
    "wallets": []
  },
  "access": {
    "type": "unrestricted"
  },
  "streaming": {
    "type": "allow-list",
    "wallets": []
  }
}
```

### Entity Structure

The `entity` column stores the full Decentraland entity JSON. Key fields include:

```json
{
  "id": "bafkreihpipyhrt75xyquwrynrtjadwb373xfosy7a5rhlh5vogjajye3im",
  "type": "scene",
  "timestamp": 1699123456789,
  "pointers": ["myworld.dcl.eth"],
  "content": [
    {
      "file": "scene.json",
      "hash": "QmHash..."
    },
    {
      "file": "models/scene.glb",
      "hash": "QmHash..."
    }
  ],
  "metadata": {
    "worldConfiguration": {
      "minimap": { ... },
      "skybox": { ... }
    },
    "owner": "0x..."
  }
}
```

### Deployment Auth Chain Structure

The `deployment_auth_chain` column stores an array of authentication links:

```json
[
  {
    "type": "SIGNER",
    "payload": "0xd9b96b5dc720fc52bede1ec3b40a930e15f70ddd",
    "signature": ""
  },
  {
    "type": "ECDSA_PERSONAL_EPHEMERAL",
    "payload": "Decentraland Login\nEphemeral address: 0x...\nExpiration: ...",
    "signature": "0x..."
  }
]
```

### Constraints and Business Rules

1. **Name Uniqueness**: Each world name must be unique (enforced by primary key)
2. **Name Format**: World names should be lowercase (handled by application layer)
3. **Permissions**: Must never be NULL (enforced by NOT NULL constraint)
4. **Owner Validation**: The `owner` field is validated against blockchain DCL name ownership
5. **Size Calculation**: The `size` field is calculated from entity content file sizes stored in S3/disk
6. **Address Normalization**: All Ethereum addresses in permissions are stored in lowercase

---

## Table: `blocked`

Stores wallet addresses that have been blocked from deploying or accessing worlds.

### Schema

```sql
CREATE TABLE blocked
(
    wallet VARCHAR NOT NULL PRIMARY KEY,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE INDEX blocked_wallet_index ON blocked (wallet);
```

### Columns

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `wallet` | VARCHAR | NOT NULL | **Primary Key**. Ethereum address of the blocked wallet (lowercase). |
| `created_at` | TIMESTAMP | NOT NULL | Timestamp when the wallet was first blocked. |
| `updated_at` | TIMESTAMP | NOT NULL | Timestamp when the block record was last updated. |

### Indexes

- **Primary Key**: `wallet`
- **Index**: `blocked_wallet_index` on `wallet` column

### Business Rules

1. Wallet addresses are stored in lowercase
2. Blocked wallets are checked before allowing deployments and access

---

## Table: `migrations` (Internal)

Tracks which database migrations have been executed. This table is managed automatically by the migration system.

### Schema

```sql
CREATE TABLE migrations
(
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    run_on TIMESTAMP NOT NULL
);
```

### Columns

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | SERIAL | NOT NULL | **Primary Key**. Auto-incrementing ID. |
| `name` | VARCHAR(255) | NOT NULL | Migration identifier (e.g., `"0002_create_worlds_table"`). |
| `run_on` | TIMESTAMP | NOT NULL | Timestamp when the migration was executed. |

---

## Migration History

The database schema has evolved through the following migrations:

1. **0001_fix_file_ids** - Fixed incorrectly stored file IDs (pre-database migration)
2. **0002_create_worlds_table** - Created initial `worlds` table with `acl` column
3. **0003_compute_and_store_runtime_metadata** - Added runtime metadata to world files
4. **0004_migrate_from_files_to_database** - Migrated world data from file storage to database
5. **0005_add_permissions_column** - Added `permissions` JSON column
6. **0006_migrate_acls_to_permissions** - Migrated ACL data to permissions format
7. **0007_fix_empty_permissions** - Fixed worlds with empty permissions
8. **0008_make_permissions_column_not_null** - Made `permissions` column required
9. **0009_drop_acl_column** - Removed deprecated `acl` column
10. **0010_remove_world_metadata_files** - Cleanup migration for file storage
11. **0011_add_size_and_owner_columns** - Added `size` and `owner` columns
12. **0012_store_world_owner_and_size** - Populated `size` and `owner` from entity data
13. **0013_create_blocked_table** - Created `blocked` table
14. **0014_permissions_set_addresses_lowercase** - Normalized all permission addresses to lowercase

---

## Relationships

- **`worlds.deployer`** → Ethereum address (no foreign key, references blockchain data)
- **`worlds.owner`** → Ethereum address (no foreign key, validated against DCL name ownership)
- **`blocked.wallet`** → Ethereum address (can be referenced by `worlds.deployer` for access checks)

---

## Common Queries

### Get all deployed worlds
```sql
SELECT name, entity_id, owner, size, created_at 
FROM worlds 
WHERE entity_id IS NOT NULL 
ORDER BY name;
```

### Get world permissions
```sql
SELECT name, permissions 
FROM worlds 
WHERE name = 'myworld.dcl.eth';
```

### Check if wallet is blocked
```sql
SELECT wallet 
FROM blocked 
WHERE wallet = LOWER('0x...');
```

### Get worlds by deployer
```sql
SELECT name, entity_id, created_at 
FROM worlds 
WHERE deployer = LOWER('0x...') 
AND entity_id IS NOT NULL;
```

### Get world entity data
```sql
SELECT name, entity, entity_id, owner 
FROM worlds 
WHERE name = 'myworld.dcl.eth' 
AND entity_id IS NOT NULL;
```

---

## Notes for AI Agents

1. **Case Sensitivity**: All world names and Ethereum addresses are stored in lowercase
2. **JSON Columns**: The `permissions`, `entity`, and `deployment_auth_chain` columns use PostgreSQL JSON type
3. **Null Handling**: `entity_id` can be NULL if a world record exists but no deployment has been made
4. **Size Calculation**: The `size` field is computed from content file sizes, not stored directly in entity
5. **Permission Validation**: Permission checks are handled in application layer (`src/logic/permissions-checker.ts`)
6. **Owner Validation**: The `owner` field is validated against blockchain via `nameOwnership` component
7. **Migration System**: Migrations are auto-executed on startup via `migrationExecutor` component
8. **Storage Separation**: Entity content files are stored separately in S3/disk storage, not in the database

---

## Related Code

- **Migrations**: `src/migrations/`
- **World Manager**: `src/adapters/worlds-manager.ts`
- **Permissions Checker**: `src/logic/permissions-checker.ts`
- **Types**: `src/types.ts` (see `WorldRecord`, `Permissions`, `BlockedRecord`)

