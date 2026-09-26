/**
 * tandem-camp: Tandem's installable admin.
 *
 * A host mounts this the way `@payloadcms/next` mounts Payload's admin:
 * one config module (calling mountTandemCamp once, imported for its side
 * effect by every Camp route in the deployment) plus one catch-all route
 * re-exporting CampRootPage. See this package's README for the exact host
 * wiring and current migration status -- Overview, Leads, and Payouts are
 * migrated from examples/dashboard today; the rest are not yet.
 */
export { mountTandemCamp, type TandemCampConfig } from "./config.js";
export { CampRootPage } from "./root.js";
export * from "./queries.js";
export * from "./actions.js";
