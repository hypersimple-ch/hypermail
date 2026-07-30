# Migration and rollback runbook

## Migration

1. Confirm a recent, restorable PostgreSQL backup and record the currently deployed immutable image digests.
2. Render the intended compose configuration and run `node infra/verify-deployment.mjs`.
3. Put the worker in a controlled pause/drain state using its application control before schema work. Do not delete queue tables or Hypermail state.
4. Run `pnpm db:migrate` once from a reviewed, private job/container with the production `DATABASE_URL`; do not run it concurrently from web and worker.
5. Deploy web, then worker. Check liveness first and sanitized readiness next. Resume the worker only after readiness succeeds.

## Rollback

1. Stop or pause the worker to prevent new mutations.
2. Roll web and worker back to the recorded image digests. Keep PostgreSQL and Hypermail volumes intact.
3. Do **not** reverse a database migration automatically. Restore a tested backup only when the migration's explicit rollback procedure requires it and the impact is approved.
4. Verify the old version's readiness, inspect queue reconciliation, then resume the worker.

Never use `docker compose down -v`, delete named volumes, or recreate Hypermail state as a rollback shortcut.
