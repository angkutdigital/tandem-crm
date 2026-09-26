import Stripe from "stripe";
import type { TandemPayoutAdapter } from "tandem-crm";

/**
 * Reference TandemPayoutAdapter against Stripe Connect. This is example
 * code for the Camp reference dashboard, not something tandem-crm's core
 * package ships or depends on -- see the package README's dependency-shape
 * reasoning for why a vendor payment SDK never belongs in the engine.
 *
 * A host wires this up by supplying:
 * - a Stripe secret key with Connect enabled, and
 * - resolveConnectedAccountId: their own partnerId -> Stripe connected
 *   account id mapping. Tandem has no concept of "partner payment
 *   account"; that mapping is entirely the host's data, the same way
 *   TandemAuthAdapter never invents an identity system.
 *
 * This dashboard's own getConfiguredPayoutAdapter() in lib/actions.ts wires
 * it up from two env vars for local development; a real deployment would
 * resolve the connected account id from its own partners table instead of
 * a flat env var.
 */
export function createStripePayoutAdapter(options: {
  stripeSecretKey: string;
  resolveConnectedAccountId: (partnerId: string) => Promise<string>;
}): TandemPayoutAdapter {
  const stripe = new Stripe(options.stripeSecretKey);

  return {
    async executePayout({ payoutId, partnerId, amountMinor, currency }) {
      const destination = await options.resolveConnectedAccountId(partnerId);
      if (!destination.trim()) {
        throw new Error(`no Stripe connected account is mapped for partner "${partnerId}"`);
      }

      // The idempotency key is derived from payoutId alone (not a fresh
      // random value per call), so a retried request -- a network timeout,
      // a duplicate click before the UI disables itself -- reaches Stripe's
      // own idempotency layer and returns the original transfer instead of
      // moving money twice. This is what TandemPayoutAdapter's own contract
      // asks every implementation to guarantee.
      const transfer = await stripe.transfers.create(
        {
          amount: amountMinor,
          currency: currency.toLowerCase(),
          destination,
          transfer_group: `tandem-payout-${payoutId}`,
        },
        { idempotencyKey: `tandem-payout-${payoutId}` }
      );

      return { payoutReference: transfer.id };
    },
  };
}
