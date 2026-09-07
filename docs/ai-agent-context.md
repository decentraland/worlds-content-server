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
- Presence: Pulse (optional, only when `PRESENCE_SOURCE` is `pulse` or `both` — see below)

**Key Concepts:**

- **World**: A scene identified by a DCL name rather than parcel coordinates
- **Addressable URN**: Entity URN format enabling global portable experiences and single-scene loading
- **Global Portable Experience**: Experiences loaded for all users (via GLOBAL_PX query parameter)
- **Single Scene**: Load a specific scene instead of Genesis City (via SPACE query parameter)

**Worlds vs Genesis City Realms:**

A World realm is fundamentally different from a Genesis City realm:

- **Isolation**: A World is a fully isolated realm. Users connected to a World can only see and interact with other players within that same World. There is no cross-realm visibility — players in a World are completely separate from players in Genesis City or any other World.
- **Full Realm**: The Worlds Content Server functions as a complete, self-contained realm. It directly serves the `/world/{name}/about` endpoint that clients use to connect, provides content URLs, and configures the comms adapter. It is not a thin description layer — it is the actual realm implementation for Worlds.
- **LiveKit Gatekeeper for Worlds**: The Worlds Content Server acts as a LiveKit gatekeeper for World scenes. It controls who is allowed to access and connect to a World's comms room, governing which players can interact with each other inside that World. This is enforced via the World's ACL (`access` and `streaming` settings in the `worlds.permissions` JSON column). This is distinct from Genesis City, where comms-gatekeeper handles that role.
- **Separate LiveKit Infrastructure**: At the infrastructure level, Worlds and Genesis City may use different LiveKit accounts or clusters. The comms infrastructure is not necessarily shared between them.
- **Content is Always Public**: While comms access can be restricted by the World owner (controlling who can enter and interact), the scene content files itself are always publicly accessible. The Worlds Content Server is a public content server — anyone can fetch scene files by content hash regardless of comms access restrictions.

**Presence Source:**

Where the online-player counters come from is configurable, because Pulse is becoming the platform's
single source of online-player information. Only the *counters* move; access control does not.

- `PRESENCE_SOURCE=livekit` (default, today's behaviour): `commsAdapter.status()` counts users from
  the LiveKit room listing, and `/wallet/{wallet}/connected-world` answers from `peersRegistry`
  (fed by the LiveKit webhook).
- `PRESENCE_SOURCE=pulse`: `commsAdapter.status()` — and with it `/live-data` and `/status`'s `comms`
  block — is built from `GET ${PULSE_URL}/realms`, filtered to realms whose name ends in `.dcl.eth`;
  `/wallet/{wallet}/connected-world` answers from `GET ${PULSE_URL}/peers/{wallet}` — wallet
  lowercased, answer cached in memory for 5 s per wallet, since the route is public and unthrottled.
  The published response shapes are unchanged, and `comms.adapterType` keeps naming the transport,
  not the counter.
- `PRESENCE_SOURCE=both`: serves the LiveKit answer and counts the divergence against Pulse in
  `presence_shadow_diff{kind="live-data"}` (counts only, never addresses).
- LiveKit stays the source for anything that decides access: the `MAX_USERS_PER_WORLD` capacity
  check, participant kicks, access-change re-checks and the community-member-removed flow. Those
  paths carry an `iteration-2 exception` comment.
- `PUBLISH_PEER_WORLD_EVENTS` (default `true`) gates the `peer.<address>.world.join|leave` NATS
  publish in the LiveKit webhook; the `peersRegistry` update is never gated. `false`, `0` and `no`
  (trimmed, any casing) switch it off; anything else keeps publishing. The publish is removed once
  social-service-ea reads world presence from Pulse.
- `/wallet/{wallet}/connected-world` is deprecated in `docs/openapi.yaml`: Pulse's
  `GET /peers/{id}` replaces it once unity-explorer reads Pulse directly.

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
