# AI Agent Context

**Service Purpose:** Content server specifically for Decentraland Worlds (named scenes). Enables deployment and retrieval of world scenes that are identified by DCL names rather than parcel coordinates. Supports global portable experiences and single-scene loading.

**Key Capabilities:**

- Stores and serves World entity deployments (scenes associated with DCL names)
- Validates deployment ownership (deployer must own the DCL name in scene.json)
- Provides content retrieval API for world scenes
- Supports addressable URNs for global portable experiences and single-scene loading
- Uses @dcl/catalyst-storage for entity storage (disk or S3)

**Communication Pattern:** Synchronous HTTP REST API

**Technology Stack:**

- Runtime: Node.js
- Language: TypeScript
- HTTP Framework: @well-known-components/http-server
- Storage: @dcl/catalyst-storage (entity content storage)
- Component Architecture: @well-known-components (logger, metrics, http-server)

**External Dependencies:**

- Database: PostgreSQL (world metadata, permissions, blocked wallets)
- Storage: Local disk or AWS S3 (via @dcl/catalyst-storage)
- Blockchain: DCL Names ownership validation (deployer must own name)
- Communication: LiveKit (optional, for comms adapter configuration)

**Key Concepts:**

- **World**: A scene identified by a DCL name rather than parcel coordinates
- **Addressable URN**: Entity URN format enabling global portable experiences and single-scene loading
- **Global Portable Experience**: Experiences loaded for all users (via GLOBAL_PX query parameter)
- **Single Scene**: Load a specific scene instead of Genesis City (via SPACE query parameter)

**Deployment Requirements:**

- Deployer wallet must own the DCL name specified in scene.json
- World name in scene.json must match owned DCL name

**Database Schema:**

- **Tables**: `worlds` (world deployments, permissions, metadata), `blocked` (blocked wallets), `migrations` (migration tracking)
- **Key Columns**: `worlds.name` (PK), `worlds.entity_id`, `worlds.permissions` (JSON), `worlds.owner`, `worlds.size`
- **Permissions**: Stored as JSON with `deployment`, `access`, and `streaming` settings (allow-list, unrestricted, shared-secret, NFT ownership)
- **Full Documentation**: See [docs/database-schema.md](docs/database-schema.md) for detailed schema, column definitions, and relationships

## Database Notes for AI Agents

1. **Case Sensitivity**: All world names and Ethereum addresses are stored in lowercase
2. **JSON Columns**: The `permissions`, `entity`, and `deployment_auth_chain` columns use PostgreSQL JSON type
3. **Null Handling**: `entity_id` can be NULL if a world record exists but no deployment has been made
4. **Size Calculation**: The `size` field is computed from content file sizes, not stored directly in entity
5. **Permission Validation**: Permission checks are handled in application layer (`src/logic/permissions-checker.ts`)
6. **Owner Validation**: The `owner` field is validated against blockchain via `nameOwnership` component
7. **Migration System**: Migrations are auto-executed on startup via `migrationExecutor` component
8. **Storage Separation**: Entity content files are stored separately in S3/disk storage, not in the database
