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
5. An expired upload needs a newly timestamped/signed entity. Retries do not extend upload lifetime.
6. Overlapping uploads coexist within quotas. Publication uses entity timestamp ordering, breaking
   ties by entity ID; completion order never lets an older entity overwrite a newer deployed entity.

`400` covers validation, expiry and admission failures. `408` covers processing deadlines. Clients
must distinguish `200` from `202`, handle terminal validation failures, retry transient transport
failures, and use the returned missing list rather than subtracting a new global availability result.
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

Default limits: 10 uploads/account, 1 GiB staged/account, 50 GiB staged/server database, 512 MiB accepted
batch bytes/account/minute, 24-hour pending lifetime and 24-hour completion retention. All are configured
in `.env.default`. Staging charges manifest bytes and referenced content; reused content is charged
conservatively per upload. Expired slots and bytes remain charged if physical cleanup fails.

Migration `0028_partial_upload_progress` adds receipt/accounting tables. Quiesce GC and finish or drain
old pending uploads before rolling out: older binaries do not honor the content lock or populate byte
reservations. All replicas accessing the same storage must use this protocol and database lock key.
The lock pool uses `CONTENT_LOCK_CONNECTIONS` connections per replica in addition to the query pool.
Uploads share the lock; GC briefly excludes uploads per 1,000-key batch. Requests for one entity are
serialized, while separate entities can upload concurrently. This favors correctness over maximum
same-entity batch parallelism. Storage transports must have timeouts and honor write cancellation;
protection remains held until started writers settle, so an unresponsive backend can delay GC.

Monitor `partial_upload_metadata_checks`, `partial_upload_batches`, `partial_upload_reserved_bytes`,
`partial_upload_cleanup_backlog_bytes`, and the existing deployment stage duration/worker metrics.
Reserved-byte gauges are database snapshots updated by admission/cleanup, not instantaneous counters.
The progress integration test asserts one initial inventory, zero metadata probes for intermediate
batches and one final verification (2N probes instead of approximately 2NB for N hashes in B batches).
These counts are structural measurements, not S3 throughput or latency benchmarks.
