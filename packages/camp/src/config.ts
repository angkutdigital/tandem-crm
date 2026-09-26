import type { Pool } from "pg";
import type { TandemAuthAdapter, TandemAdminAdapter, TandemPayoutAdapter } from "tandem-crm";

/**
 * What a host supplies to mount Camp. Mirrors the engine's own adapter
 * pattern (TandemAuthAdapter, TandemPayoutAdapter) rather than inventing a
 * second config shape -- a host that already implemented these for direct
 * engine use passes the same objects in here.
 */
export type TandemCampConfig = {
  /** The same pool a host's own inbound adapters/writers use. Camp opens
   * no connection of its own. */
  pool: Pool;
  /** Camp mounts one workspace per deployment, the same assumption
   * examples/dashboard's own TANDEM_WORKSPACE_ID makes today. A
   * multi-workspace host runs one Camp mount per workspace (or resolves
   * this dynamically before calling mountTandemCamp -- see the
   * "One workspace per mount" note in the README). */
  workspaceId: string;
  authAdapter: TandemAuthAdapter;
  /** Required only by the views that create agent profiles or link an
   * existing host account (Workspace setup). Omit it and those actions
   * throw a clear "not configured" error instead of silently no-op'ing --
   * same fail-closed convention as everywhere else in this package. */
  adminAdapter?: TandemAdminAdapter;
  /** Required only by the Payouts view's "Pay" action. Omit it and that
   * one action throws a clear "not configured" error; every read-only view
   * still works without it. */
  payoutAdapter?: TandemPayoutAdapter;
};

let mounted: TandemCampConfig | null = null;

/**
 * Registers the config every Camp view and server action reads for the
 * lifetime of this process. Call it exactly once, as a side effect of
 * something every Camp route is guaranteed to import first -- the
 * README's quickstart has the host import their config module from their
 * shared Camp layout for this reason. Calling it more than once (e.g. hot
 * reload in dev) simply re-registers; that's fine, the same object your
 * config module already holds.
 *
 * Not a per-request thing: Camp assumes a single long-running Node
 * process (the same assumption withTandemSession's connection pool
 * already makes), not a stateless edge function. See the README's
 * "Deployment shape" note.
 */
export function mountTandemCamp(config: TandemCampConfig): void {
  if (!config.workspaceId?.trim()) throw new Error("tandem-camp: config.workspaceId is required");
  mounted = config;
}

/** Internal: every Camp view/action calls this instead of importing env
 * vars directly, the one seam that replaced examples/dashboard's
 * `lib/db.ts` reading `process.env.DATABASE_URL`/`TANDEM_WORKSPACE_ID`
 * at module load. */
export function getTandemCampConfig(): TandemCampConfig {
  if (!mounted) {
    throw new Error(
      "tandem-camp: mountTandemCamp(config) has not been called yet. " +
        "Call it in a config module imported (for its side effect) by every " +
        "Camp route in this deployment -- see the README's quickstart."
    );
  }
  return mounted;
}
