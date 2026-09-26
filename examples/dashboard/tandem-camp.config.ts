import { mountTandemCamp } from "tandem-camp";
import { pool, WORKSPACE_ID } from "./lib/db";
import { dashboardAuthAdapter } from "./lib/auth";
import { createStripePayoutAdapter } from "./lib/stripePayoutAdapter";

/**
 * This is a live test host for Camp within the reference dashboard app,
 * reusing the exact same pool/workspace/auth/payout wiring the rest of
 * this app already has -- not a second, separate configuration to keep in
 * sync. A real standalone host would build its own config the same shape,
 * against its own auth provider.
 *
 * Guarded, not called unconditionally: Next.js evaluates every route
 * module's imports during its build-time "collect page data" step, even
 * for a force-dynamic route that fetches nothing at build time. Without
 * this guard, `mountTandemCamp` throws its own (correct, intentional)
 * "workspaceId is required" validation error during that step whenever
 * TANDEM_WORKSPACE_ID isn't set at build time -- which fails the entire
 * `next build`, not just this one route, in an environment (a fresh CI/CD
 * deploy) where that env var may simply not be wired up yet. This route
 * is a verification harness for Camp development, not a real product
 * surface; it should never be able to block a deploy of the actual
 * dashboard on its own.
 */
if (WORKSPACE_ID) {
  mountTandemCamp({
    pool,
    workspaceId: WORKSPACE_ID,
    authAdapter: dashboardAuthAdapter,
    payoutAdapter:
      process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CONNECTED_ACCOUNTS
        ? createStripePayoutAdapter({
            stripeSecretKey: process.env.STRIPE_SECRET_KEY,
            resolveConnectedAccountId: async (partnerId) =>
              JSON.parse(process.env.STRIPE_CONNECTED_ACCOUNTS!)[partnerId] ?? "",
          })
        : undefined,
  });
}
