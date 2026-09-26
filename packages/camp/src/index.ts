/**
 * tandem-camp: Tandem's installable admin, in progress.
 *
 * This package exists as its own npm package -- not a subpath of
 * tandem-crm -- specifically so installing the engine never pulls in an
 * admin UI's dependencies (charts, drag-and-drop, a data grid, Next.js
 * itself). See this package's README for the measured size reasoning.
 *
 * Nothing here is real yet. The actual screens currently live as a
 * reference app in examples/dashboard; migrating them into this package,
 * route by route, behind a real mount API, is the next work -- not a
 * config flag to flip.
 */
export function mountTandemCamp(): never {
  throw new Error(
    "tandem-camp is not implemented yet. See examples/dashboard for the current reference dashboard, and this package's README for where the installable admin is headed."
  );
}
