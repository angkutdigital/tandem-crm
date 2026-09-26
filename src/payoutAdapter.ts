/**
 * What Tandem needs from whatever system actually moves money on a host's
 * behalf. Mirrors authAdapter.ts's shape: a plain TypeScript interface with
 * zero vendor dependency in the core package, implemented once per payment
 * rail (Stripe Connect, Wise, a manual back-office process) and passed to
 * the host's own approve/pay action.
 *
 * Tandem never calls this itself and never will -- see domain.ts's
 * commission.paid, which only ever records that a payout already happened.
 * The intended shape is: a host's own admin action calls
 * adapter.executePayout(...), gets back a provider reference, and only then
 * appends commission.paid with that reference. If the transfer throws, no
 * commission.paid event is appended and the payout stays exactly where it
 * was (approved, not paid) -- the same non-enforcement split as everywhere
 * else money is involved in this package.
 */
export type TandemPayoutAdapter = {
  /** Executes one real transfer of amountMinor (already an integer minor
   * unit, e.g. cents) in currency to whatever destination the host's own
   * partnerId -> payment-account mapping resolves, and returns the
   * provider's own reference for it (a Stripe transfer id, a bank
   * reference, etc.) for commission.paid's payoutReference. Must be safe to
   * retry with the same payoutId without creating a second real transfer --
   * see examples/dashboard's Stripe reference implementation for one way to
   * do that (an idempotency key derived from payoutId). */
  executePayout(payout: {
    payoutId: string;
    partnerId: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ payoutReference: string }>;
};
