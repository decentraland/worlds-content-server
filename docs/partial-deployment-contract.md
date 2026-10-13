# Partial deployment contract

The wire protocol extends `POST /entities` with multipart `partial=true`. It uses the signed entity
ID as the upload identifier; there is no session creation or explicit commit endpoint.

1. Send the manifest, `entityId`, auth chain and any subset of its files.
2. A `202 { missing: string[] }` acknowledges stored files, not publication. Send those hashes in
   additional requests, retaining the signed entity ID. The original signer may omit the manifest.
3. The request completing the set validates current publication authority and deploys synchronously.
   It returns `200 { creationTimestamp, ...serviceSpecificFields }`.
4. Replaying completion with valid authentication returns the original result during completion
   retention. It does not redeploy an entity subsequently replaced or undeployed.
5. Any batch for an entity that is currently published, from any signer and with or without the
   manifest, returns `200` with the publication's `creationTimestamp`. The entity ID is the hash of
   the entity file, so the live entity is exactly what the uploader wanted.
6. An expired upload needs a newly timestamped/signed entity. Retries do not extend upload lifetime.
7. Overlapping uploads coexist within quotas. Publication uses entity timestamp ordering, breaking
   ties by entity ID; completion order never lets an older entity overwrite a newer deployed entity.
   The timestamp is chosen by the signer and may be up to 15 minutes in the future (as on Catalyst),
   so a collaborator with deploy permission who keeps redeploying with such timestamps can keep
   blocking the owner's redeploys on those parcels indefinitely; the owner recovers by revoking that
   collaborator's deploy permission.

`400` covers validation, expiry and requests that alone exceed a budget (a batch above the per-minute
byte rate, or an upload above the per-account or per-world staging budget); no retry can succeed. `429` with
`Retry-After` means a budget is full because of other uploads or traffic; the quota is one of
`uploads_per_account`, `uploads_per_world`, `bytes_per_account`, `bytes_per_world`, `bytes_per_server` or
`bytes_per_minute` (the `reason` label of `partial_upload_throttled`). `408` covers processing
deadlines. `413` means the body exceeds a multipart size or count limit; send smaller batches.
Clients must distinguish `200` from `202`, handle terminal validation failures, retry transient
transport failures, and use the returned missing list rather than subtracting a new global
availability result.
A rate rejection uses a fixed one-minute accounting window; repeated requests within it will not help.

## Catalyst adapter

`test/contracts/partial-deployment.ts` exports an HTTP-only suite. A service adapter supplies a fresh,
authorized scene with at least two distinct absent content hashes and a multipart sender. Worlds runs
this suite in `test/integration/partial-deploy.spec.ts`. A Catalyst adapter must use its own scene
ownership fixtures and route prefix; it must also implement staging before the suite can pass. This
change does not claim that the current Catalyst endpoint supports `partial=true`.

Catalyst must retain its entity validation/access rules and size accounting, anchor local upload
freshness at admission, keep pending uploads local to the receiving server, and expose only committed
entities to snapshots and peer synchronization. Its deployment-derived GC needs an explicit expired
staging sweep; files never attached to a deployment would otherwise be invisible to cleanup.

## Operation and rollout

Default limits: 10 uploads/account, 4 live uploads/world (3 for one account), 1 GiB staged/account, twice the
world's scene size cap staged/world, 50 GiB staged/server database, 512 MiB accepted batch bytes/account/minute, 1-hour pending
lifetime (expired uploads cleaned up every 5 minutes) and
24-hour completion retention. All are configured in `.env.default`. The staging budgets charge the bytes an
upload stores itself (the manifest and content that was not in storage) and content that is in storage only
because other pending uploads staged it or nothing references it, so pending uploads cannot keep content
alive outside the budgets. Only content already referenced by published content (a world scene, including
one awaiting eviction, or a world thumbnail) when the upload starts is not charged; the pending upload's
manifest protects it from garbage collection. A batch file that is already stored, before the upload or by
an earlier batch, is dropped without being stored again and keeps the charge decided for it, and every
received byte counts against the per-minute rate. The scene size limit still
counts every file of the scene; for DCL-name worlds it is the owner's remaining allowance capped at
`MAX_SCENE_SIZE` (500 MiB), which startup requires to fit `MAX_PENDING_BYTES_PER_DEPLOYER`.
A world owner can grant deploy permission to any number of addresses, each with its own account budgets,
so the per-world limits (`MAX_PENDING_DEPLOYMENTS_PER_WORLD`, of which one account may hold all but one, and
`PENDING_BYTES_PER_WORLD_FACTOR` times the world's scene size cap) keep one world's deployers from filling the
server budget for everyone else. The world's cap doesn't depend on the owner's allowance or the parcels: it is
the whitelisted size, `ENS_MAX_SIZE` for ENS worlds (72 MiB of staging for 36 MiB) or `MAX_SCENE_SIZE`. The
world byte budget counts content bytes, not entity files, so even with a factor of 1 a scene within the cap
fits. Both world limits count only the world's live uploads, from every deployer. Expired slots and
bytes stay charged to the account and server budgets if physical cleanup fails; the failing upload is retried by the next run
without holding back later ones. Each run visits every upload expired by the database clock when it starts, unless uploads keep
the content lock busy, and runs (scheduled or from `POST /gc`) never overlap. When uploads keep the content
lock busy past the writer wait, `POST /gc` answers `503` with `Retry-After: 60`.

Migrations run at startup. Worlds runs as a single instance behind Cloudflare, so a normal deploy is
enough. The content lock uses `CONTENT_LOCK_CONNECTIONS` connections in addition to the query pool.
Partial batches hash their files and, when they carry the manifest, run their staging validation
(including the permission check) before taking it; regular deployments first run their pre-storage
validation.
Uploads share the lock; GC briefly excludes uploads per 1,000-key batch. Requests for one entity are
serialized, while separate entities can upload concurrently. This favors correctness over maximum
same-entity batch parallelism. Storage transports must have timeouts and honor write cancellation;
protection remains held until started writers settle, so an unresponsive backend can delay GC.

Monitor `partial_upload_metadata_checks`, `partial_upload_batches`, `partial_upload_reserved_bytes`,
`partial_upload_cleanup_backlog_bytes`, `partial_upload_cleanup_failed_uploads`, and the existing deployment stage duration/worker metrics.
`multipart_upload_receive_duration_seconds{route,outcome}` times each body from request arrival until it is
parsed (`completed`) or rejected, separating network time from server time. After parsing,
`deployment_processing_stage_duration_seconds{stage}` splits `total` into `lookup` (pending-upload, replay,
newer-scene and stored-manifest reads), `hash`, `authorization`, `lock` (waiting for the content lock),
`limits` (size quota), `metadata`, `admission` (batch admission and progress bookkeeping), `storage` and
`persistence`. These are disjoint, except `permission` (name ownership and parcel permission), which runs
inside `authorization`. `lookup` and `admission` record one sample per call, so a request can add several;
their `_sum` series still split `total`. `hash` only times files not hashed earlier in the request. Request
authentication and small in-memory steps are not timed.
Every `deployment_processing_*` series carries `mode` (`regular` or `partial`), so single-request deployments and
partial batches can be told apart; aggregating by `stage` alone still sums both.
Reserved-byte gauges are database snapshots updated by admission/cleanup, not instantaneous counters.
The progress integration test asserts one initial inventory and zero metadata probes afterwards, including
the publishing batch (N probes instead of approximately 2NB for N hashes in B batches). Publication takes
content sizes from the upload's receipts: GC never deletes content a live upload references, and the content
lock is held through publication. GC, expired-upload cleanup and publication judge expiry on the database clock
(`now()`, the transaction start), and a publication's transaction starts after it takes the shared content lock, so
an upload GC already saw expired is refused at publication; admission uses the instance clock, which at worst wastes
a batch. Content deleted out of band between batches is not re-requested.
These counts are structural measurements, not S3 throughput or latency benchmarks.
