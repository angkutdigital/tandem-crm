# Contributing to Tandem

Thanks for taking a look. Tandem is an early, open source project from [Angkut Digital](https://tandemcrm.dev/about/). It is built by a small team with AI assistance, and we are learning as we go. We read every issue and pull request, but we are not always fast, so please be patient. There is no CLA and no formal governance. We keep the process light.

By taking part you agree to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to help

You do not need to write code to help.

- **Try it on your Postgres host** and tell us how it went. The "Tested on" list on the [homepage](https://tandemcrm.dev/#tested) only covers hosts we have run ourselves. Use the "Postgres host report" issue form. A passing report, a failing one and a "needed one extra setting" report are all useful.
- **Report bugs and confusing docs.** If a guide did not work as written, that is a bug in the guide.
- **Improve the docs.** The guides live in the [docs repository](https://github.com/angkutdigital/tandem-site). Plain language and working examples matter most.
- **Pick up an issue.** Look for [good first issue](https://github.com/angkutdigital/tandem-crm/labels/good%20first%20issue) and [help wanted](https://github.com/angkutdigital/tandem-crm/labels/help%20wanted).
- **Fork it.** Tandem is MIT licensed. If you need something we will not build, fork it and shape it to your needs. We would like to hear what you changed.

For anything bigger than a small fix, please open an issue first so we can agree on the approach before you spend time on it.

## Development setup

You need Node 20 or later and a Postgres 14 to 18 database where you are the owner or a superuser. The tests are not mocked: they run against a real database.

The quickest way to get one is Docker:

```sh
docker run --name tandem-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:17
```

Then, from the repository root:

```sh
npm ci
npm run build
npm run build --prefix packages/camp
```

Create an empty database for each suite, because the suites seed their own data and do not clean up:

```sh
createdb -h localhost -U postgres tandem_rls
createdb -h localhost -U postgres tandem_e2e
```

## Checks before opening a PR

These must pass:

```sh
npm run typecheck
npm test
npm run build
```

If your change touches migrations, Postgres functions, grants, row-level security, or anything that moves money, also run the two database suites:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tandem_rls node scripts/ci-rls-check.mjs
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tandem_e2e node scripts/e2e-money-actions.mjs
```

CI runs the unit tests on Node 20 and 22, both database suites on Postgres 14, 15, 16, 17 and 18, and the whole set again with a limited, non-superuser admin account. A change must not break any of them.

## Project layout

- `src/` is the engine. `domain.ts` is the event reducer, `commissions.ts` is the commission rules, `db/leadWriter.ts` is the shared writer every app uses to write events.
- `db/migrations/` holds the SQL.
- `packages/camp/` is the optional admin UI, `tandem-camp`.
- `examples/dashboard/` is a reference Next.js app.
- `scripts/` holds the database test suites.

The toolchain is TypeScript with NodeNext modules, Vitest for tests, and `tsc` for typecheck and build. `pg` is the only runtime dependency of the engine, and we want to keep it that way.

`examples/dashboard` and `packages/camp` are built on `@base-ui/react`, not Radix, even though the components follow shadcn/ui's file layout and naming. A few APIs differ in ways that silently do the wrong thing if you assume Radix: use `render={<Link href="/" />}` instead of `asChild`, and `DropdownMenuItem` fires `onClick`, not `onSelect`.

## Rules for code that moves money

Tandem decides who gets paid. Two audits found their worst bugs in exactly this kind of code, so these rules are not optional:

- Every write to a lead goes through the shared writer in `src/db/leadWriter.ts`. It locks the lead row first, replays the full history plus the new events, and only then inserts. Do not write events with hand-built SQL.
- Money is integer minor units. No floating point, anywhere.
- Every decision is saved in the event it was made in (a rate, a qualification result, a beneficiary), so changing the configuration later never rewrites history. Replaying an old history must give the same answer it always did.
- Agents may append only `lead.lost`, `lead.stage_changed` and `conversion.confirmed`. Payments, commissions and house-account moves need an owner or admin, and the database enforces it.
- The `tandem-engine` source and `commission.eligible` belong to the scheduled release job alone.
- A fix needs a test that fails without it. For money and security changes, run the test against the old code and confirm it fails.

## SQL migrations

- Migrations are plain SQL files in `db/migrations/`. `applyTandemMigrations()` applies them in order and records them in `tandem.schema_migrations`.
- Each file applies as one transaction.
- Never edit a migration that has been published to npm. To replace an older one, add a new file with a `-- tandem:supersedes` comment naming the old one.
- Every new migration must be covered by the database suites.

## Security-sensitive changes

A mistake in a function, a grant or a row-level security policy can leak rows across tenants without any error. Reading the SQL is not enough.

- Run the migration against a real Postgres.
- Reproduce the isolation boundary with concrete cross-tenant checks, and require Postgres error code `42501` for things that must be refused.
- In the pull request, say exactly what you ran and what you saw. "Should work" is not evidence.

To report a vulnerability, do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Using AI to contribute

We build Tandem with AI, so we are happy for you to as well. You are responsible for what you submit: read it, run the checks above, and be able to explain why it is right. Say in the pull request if AI wrote most of it, so reviewers know to look closely.

## Docs and writing

Write in plain language. Prefer short sentences and working examples. Do not use em dashes or filler phrases. Update `CHANGELOG.md` for any change a user would notice, in the existing Keep a Changelog format.

## Pull requests and commits

- Keep each pull request small and focused: one logical change.
- Explain why in the description, not just what.
- Do not add runtime dependencies without discussing it first.
- Link the issue or earlier pull request it relates to.

## Questions

Open an issue with the "question" label. We would rather answer a question in public, where the next person can find it.
