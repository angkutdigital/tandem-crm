# Contributing

tandem-crm is an early-stage, solo-maintained project. The repository has just opened its first PR and the package is not yet published to npm. Response times may be slow. There is no CLA and no formal governance; keep the process light.

## Development setup

Local Postgres setup is in the README under **Database setup**. Follow that section; the tests and RLS check expect a real Postgres 16 instance and are not mocked.

Toolchain:

- TypeScript with NodeNext module resolution
- dual entry points: `tandem-crm` and `tandem-crm/db`
- `pg` is the only runtime dependency
- Vitest for tests
- `tsc` for typecheck and build
- no separate linter configured yet

## Checks before opening a PR

Before opening a PR, make sure all of these pass:

- `npm run typecheck`
- `npm test`
- `npm run build`

If your change touches SQL migrations, Postgres functions, grants, or RLS policies, also run:

- `node scripts/ci-rls-check.mjs` against a Postgres 16 instance

CI runs the same RLS check against a Postgres 16 service container. A migration or RLS policy change must not break it.

## SQL migrations

- Migrations are plain SQL files in `db/migrations/*.sql`.
- They are applied in order by `applyTandemMigrations()` and tracked in `tandem.schema_migrations`.
- Each migration file applies as one transaction.
- Do not edit migration history in place. To replace an older migration, add a new file with a `-- tandem:supersedes` comment identifying the old migration.
- Any new migration must be covered by the same test/RLS flow.

## Security-sensitive SQL changes

Changes to Postgres functions, grants, or RLS policies are security-sensitive. An RLS or grant regression can silently leak rows across tenants instead of causing an obvious error. Reading the SQL is not enough.

For these changes:

- run the migration against a real Postgres instance
- reproduce the isolation boundary with concrete cross-tenant checks, not just the existing CI script
- in the PR description, state exactly what you ran and what you observed

Do not write “should work” without evidence of a live Postgres verification.

## Changelog

Update `CHANGELOG.md` at the repo root for user-facing changes. Follow the existing Keep a Changelog format.

## PRs and commits

- Keep PRs small and focused. One logical change per PR.
- Explain the “why” in the PR description, not just the “what”.
- Avoid adding new runtime dependencies; `pg` is currently the only one.
- If a change is related to an issue or earlier PR, link to it.

## Conduct

Be respectful, patient, and constructive. Assume good faith. This is a small, early project with no separate Code of Conduct file; this paragraph is the entire policy.
