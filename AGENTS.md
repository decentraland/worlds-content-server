# Agent guide — worlds-content-server

## Running tests
- `yarn test` runs the Jest unit + integration suites.
- Integration tests need Postgres. Start it with `yarn start:db`
  (docker-compose `postgres` service → host port 5450, DB `world_content_server`,
  user `postgres`). The app reads `PG_COMPONENT_PSQL_CONNECTION_STRING`.
- The suite shares one database. If a run is aborted (or the DB runs out of
  connections), later runs fail at `pg-component` start with an empty
  `AggregateError`. Restart the DB (`docker restart world_content_server_db`)
  and re-run.
