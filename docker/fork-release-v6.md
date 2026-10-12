# Fork Release: Formbricks 6.0.2

This fork retains enterprise entitlement bypass, deployment-aware email branding,
and new-user default-team SSO provisioning. Authorization remains upstream v6's
SpiceDB implementation; bypass never grants a user or API key additional access.

## Source build

Use the release-pinned toolchain and build from the repository root:

```sh
DOCKER_BUILDKIT=1 docker build --platform linux/arm64 --progress=plain \
  --build-arg RELEASE_VERSION=6.0.2 \
  -f apps/web/Dockerfile -t ghcr.io/inno-fusion/formbricks:v6.0.2 .
```

The argument reproduces upstream CI's version stamping in the build stage only.
The repository's package versions remain upstream-compatible. Check the finished
image's root package version and its compiled application version, not just its
image tag. This release is built and tested for linux/arm64; do not assume amd64
support from the upstream project's multi-architecture images.

Runtime defaults are `ENTERPRISE_BYPASS=1`, `TELEMETRY_DISABLED=1`, and
`NEXT_TELEMETRY_DISABLED=1`. In bypass mode, upstream license recheck and usage
reporting do not run. PostHog is suppressed when bypass or telemetry opt-out is
active. Provider registration still requires actual configured SSO credentials,
and license-recheck authorization and rate limits remain enforced. Bypass-off
mode retains the normal upstream entitlement lifecycle.

## Deployment is a maintenance migration

An image-only update from v5 is not supported. Preserve the existing Compose
project, database major, volumes, encryption/auth secrets, SMTP, storage, reverse
proxy settings, and worker topology. The application migration runner interleaves
schema and data migrations: use `formbricks-authzed-prepare`, not `db push` or
bare `prisma migrate deploy`.

The fork's `docker/docker-compose.yml` defaults all four application/tooling
services to the versioned fork image. Set `FORMBRICKS_IMAGE_REF` to the published
immutable digest so `formbricks`, `formbricks-migrate`, `authzed-ops`, and
`authzed-initialize` use exactly the same artifact. Do not change a floating
production tag before preparing authorization.

Required new infrastructure/configuration:

- SpiceDB `authzed/spicedb:v1.52.0` and its dedicated PostgreSQL database/role.
- `AUTHZED_DATABASE_PASSWORD` and a random, nonempty `AUTHZED_TOKEN`.
- `AUTHZED_ENABLED=true`, `AUTHZED_ENDPOINT=spicedb:50051`,
  `AUTHZED_SYSTEM_KEY=formbricks`, `AUTHZED_CONSISTENCY=fully_consistent`.
- `AUTHZED_INSECURE=true` is acceptable only on a trusted private network.
- One independent SpiceDB datastore per installation. `AUTHZED_SYSTEM_KEY` does
  not isolate independent application's data graphs: sharing a datastore between
  installations causes orphaned relationships and a blocked upgrade audit.
- Retain the existing PostgreSQL password. Changing `POSTGRES_PASSWORD` in env
  does not rotate an already-initialized database's credentials.
- Cube `ghcr.io/formbricks/cube:1.7.47-1` with this release's `docker/cube/cube.js`
  and `docker/cube/schema/FeedbackRecords.js`. Remove the old shell-based Cube
  command: the new image is shell-less and its default command starts the server.
- Retain a reviewed Hub immutable pin for both Hub and its migration service.
  Hub already existed in v5; do not silently update it through `latest`.

Stop every writer and suspend anything that restarts writers, including app,
Hub/workflow workers, import jobs, integrations, image updaters, and controllers.
Take and verify coordinated backups after writers have stopped. Start only
PostgreSQL/Redis and SpiceDB infrastructure from the reviewed v6 configuration.
With those services healthy:

```sh
docker compose --profile authzed-ops run --rm --no-deps \
  --entrypoint formbricks-authzed-prepare authzed-ops \
  --backup-confirmed --writers-stopped
```

Require exit 0, then run the existing Hub migrations before starting Hub/Cube and
the application. Keep maintenance active until fresh-login checks, scoped-key
checks, cross-tenant denial, grant revocation, and these gates pass:

```sh
docker compose --profile authzed-ops run --rm --no-deps authzed-ops upgrade check
docker compose --profile authzed-ops run --rm --no-deps authzed-ops outbox status
```

`/health` can return 200 before authorization is usable. Do not treat it as the
upgrade acceptance gate. Do not run `down -v`.

Rollback requires restoring coordinated backups and the source images/config;
starting v5 on the migrated v6 database is not a rollback. The release removes a
survey column and changes chart enum/configuration representation.

## Rehearsal scope and evidence

The upstream 6.0.2 notes do not name a tested v5/v6 upgrade pair. This fork
therefore rehearses `5.4.2 -> 6.0.2` locally, with isolated PostgreSQL pg18,
Redis, SpiceDB, Hub and Cube, rather than claiming upstream certification.

The seeded v5 fixture contains two organizations, three workspaces, an owner,
a member with a team grant, a denied member, three scoped API keys, two surveys,
a historical response, a numeric variable and an ingested hidden field.

Local checks exercise the migration runner and both authorization audits,
byte-for-byte preservation of historical response JSON, embedded-data backfill,
fresh credential logins, survey page rendering, read-only and cross-tenant API
rejection, response submission, production `can()` allow/deny decisions,
new-user SSO default-team database/projection writes, immediate grant revocation,
a repeated maintenance preparation, an independent fresh v6 database, and
backup restoration into a separate database booted with the original v5 image.

This is fixture qualification, not qualification of a particular production
backup. Real identity-provider round trips, production SMTP/storage credentials,
attachment transport, large-dataset timing, and production Hub analytics data
must be verified in that installation's own maintenance rehearsal.

Supporting checks include the full web unit suite, email/type tests, typechecks,
lint, Compose contracts, maintenance/dev scripts, and canonical authorization
schema assertions. Release evidence belongs with the published immutable image
and source SHA; do not infer completion from this document alone.

## Other compatibility notes

- API v3 survey metadata renames `hasArchived` to `workspaceSurveyCount`.
- v1/v2 remove `isSingleResponsePerEmailEnabled`; invalid v3 survey writes return 422. Contact-attribute-key APIs now require entitlement.
- Embedded-data storage keys are preserved; stricter new field naming rules can
  affect recreated/imported fields. Investigate skipped malformed/conflicting
  declarations; they are not proof of successful migration.
- SSO default-organization settings are
  `AUTH_SSO_DEFAULT_ORGANIZATION_ID` / `AUTH_SSO_DEFAULT_ORGANIZATION_ROLE`.
  An explicit default organization takes precedence over default-team inference.
- Upstream documents email follow-ups stopping on 1 December 2026.

Read the release-matched upstream guides in
`docs/self-hosting/advanced/v6-maintenance-upgrade.mdx`,
`docs/self-hosting/advanced/authzed-operations.mdx`,
`docs/self-hosting/advanced/migration.mdx`, and
`docs/surveys/embedded-data/migration.mdx` before installation maintenance.
