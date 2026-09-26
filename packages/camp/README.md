# tandem-camp

Tandem's installable admin. Mounts a full CRM interface — leads, agents,
sales activity (Trail), commissions, and disputes (Belay) — into your own
Next.js app, config-driven, the way `@payloadcms/next` or `tinacms` mount
into yours. Not a repo you fork and hack on.

**Status: scaffolding only.** The real screens don't live here yet — they're
still the reference dashboard at `examples/dashboard`. This package exists
first as an empty, correctly-bounded npm package, before any UI code moves
into it.

## Why this is a separate package, not a subpath of `tandem-crm`

Measured directly (`npm install` + `du -sh`, not estimates): the whole
`tandem-crm` engine plus its one real dependency (`pg`) is about 1 MB. A
realistic Payload install is ~433 MB beyond a bare Next.js app; a realistic
TinaCMS install is ~650 MB beyond the same baseline. The engine's own code
was never going to be the weight problem — Terrain alone compiles to 16 KB.
The weight lives entirely in an admin UI's own dependencies (charts,
drag-and-drop, a data grid, Next.js itself), so that's exactly what has to
stay opt-in. A host who only wants the engine and is building their own UI
must never see any of `tandem-camp`'s dependencies in their lockfile at
all — not hidden behind a subpath export, not behind a feature flag. A
separate published package is the only way to guarantee that.

## Dependency shape

- `tandem-crm` is a normal dependency: this package is a consumer of the
  engine, same as any other host would be.
- `next`, `react`, `react-dom`, and `tailwindcss` are peer dependencies:
  the host supplies these (same convention Payload's own Next.js
  integration uses) — this package does not install a second copy of your
  framework.
- Everything else (drag-and-drop, charts, the data grid, UI primitives) is
  this package's own concern, not the host's.

## What's next

Not a config flag to flip — the actual work is moving `examples/dashboard`'s
screens into this package behind a real mount API (`mountTandemCamp()` or
similar, still being designed), route by route, verified against real
Postgres as each one moves, then code-splitting so an unused screen (e.g. a
host not using Belay) doesn't ship its JS to every page.
