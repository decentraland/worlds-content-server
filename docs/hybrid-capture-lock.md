# Optional migration capture lock

`MIGRATION_WORLDS_CAPTURE_ENABLED=true` acquires transaction advisory lock `(179321, 2)` at the start of every Worlds manager transaction, including the dedicated abortable deployment connection. The default is disabled.

The production → dcl-one owner/quota capture adapter uses this same lock in source statement triggers on `worlds` and `blocked`. Native transactions can lock a world row before issuing a write. Without the early application lock, a captured job could hold the capture lock while waiting for that row, while the native transaction waits for the capture lock: a deadlock. Taking the lock before native row/deployment locks gives both paths one order. No request, authorization, provider or database mutation is duplicated by this option.

For activation, quiesce all source writers, deploy this option on every source replica, install the separately reviewed source capture adapter, then resume writers. Do not mix replicas using the old order with active capture triggers. Custom scripts that first lock world rows must take the same advisory lock before those locks. Existing standalone owner/quota DML acquires it through the capture statement trigger. No automatic trigger installation or deployment is performed here.

Keep source capture and target replay stopped during source schema changes. Retire capture under a writer pause before disabling the flag. The option adds serialization across Worlds transactions; measure contention under expected deployment/settings traffic before production activation.

## Validation

```sh
node_modules/.bin/jest --runInBand test/unit/worlds-manager-partial-publication.spec.ts test/unit/worlds-manager-capture-lock.spec.ts
# Set MIGRATION_WORLDS_TEST_DATABASE_URL to a disposable PostgreSQL server with CREATEDB permission.
node_modules/.bin/jest --runInBand test/unit/worlds-manager-capture-lock.spec.ts
```

Without the database environment variable, only the real PostgreSQL test is skipped. With it, the test creates and removes a unique scratch database and exercises an actual native access mutation concurrently with a captured job. The unit cases cover flag-disabled behavior and both async-context and abortable deployment transactions.
