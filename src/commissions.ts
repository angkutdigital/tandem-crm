import { calculateCommissionMinor, commissionReleaseAt, type LeadState, type TandemEvent } from "./domain.js";
import {
  defaultPartnerDeactivationPolicy,
  validateRateSchedule,
  type CommissionRateTier,
  type TandemConfig,
} from "./tandem.config.js";

/**
 * Lifetime commission helpers. All pure: they decide what should be
 * written and return the event data. The host appends it inside its own
 * transaction (or uses recordPayment / deactivatePartner from
 * tandem-crm/db, which do exactly that).
 */

type EventData<T extends TandemEvent["type"]> = Extract<TandemEvent, { type: T }>["data"];
export type CommissionHeldData = EventData<"commission.held">;
export type CommissionForfeitedData = EventData<"commission.forfeited">;
export type CommissionSkippedData = EventData<"commission.skipped">;

function parseInstant(value: string): number {
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(parsed)) {
    throw new Error("timestamp must be an ISO 8601 instant");
  }
  return parsed;
}

function addMonthsClamped(ms: number, months: number): number {
  const d = new Date(ms);
  const monthIndex = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** Whole calendar months from customerSince to `at`, in UTC. Month ends are
 * clamped (a 31 January start reaches month 1 on the last day of February).
 * `at` exactly on an anniversary counts as the new month. Never negative. */
export function customerAgeMonths(customerSince: string, at: string): number {
  const start = parseInstant(customerSince);
  const end = parseInstant(at);
  if (end <= start) return 0;
  const a = new Date(start);
  const b = new Date(end);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (addMonthsClamped(start, months) > end) months -= 1;
  return Math.max(0, months);
}

/** The tier for a customer of this age: the last tier whose fromMonth is at
 * or below it. */
export function rateForCustomerAge(schedule: readonly CommissionRateTier[], ageMonths: number): CommissionRateTier {
  validateRateSchedule(schedule);
  if (!Number.isSafeInteger(ageMonths) || ageMonths < 0) throw new Error("ageMonths must be a non-negative integer");
  let chosen = schedule[0];
  for (const tier of schedule) if (tier.fromMonth <= ageMonths) chosen = tier;
  return chosen;
}

/** The host's view of a partner at the moment a payment arrives. Read it
 * after locking the lead (recordPayment does this) so a payment racing a
 * deactivation cannot slip through with a stale "active". */
export type PartnerStatus = { id: string; active: boolean };

export type NewPayment = {
  paymentId: string;
  amountMinor: number;
  currency: string;
  /** When the payment was confirmed; becomes the event's occurredAt. */
  confirmedAt: string;
};

export type PaymentCommissionPlan =
  | { kind: "skip"; type: "commission.skipped"; data: CommissionSkippedData }
  | { kind: "hold"; type: "commission.held"; data: CommissionHeldData }
  | { kind: "forfeit"; type: "commission.forfeited"; data: CommissionForfeitedData };

/**
 * Decides the commission line for one new payment: the rate from the
 * customer's age, the amount (rounded half up), the release date, and who
 * it is owed to under the workspace's deactivation policy. Every input to
 * that decision is saved in the returned event data.
 *
 * `lead` is the lead's state before this payment is appended.
 */
export function planPaymentCommission(input: {
  lead: LeadState;
  payment: NewPayment;
  /** The status of lead.partnerId. Required when the lead has a partner. */
  partner: PartnerStatus | null;
  config: TandemConfig;
  /** The new line's id. tandem.payouts.id is a uuid. */
  payoutId: string;
  /** Overrides the config's rate schedule for this payment. */
  basisPoints?: number;
  /** Overrides the config's hold, for example a longer refund window on an
   * annual prepay. */
  holdDays?: number;
}): PaymentCommissionPlan {
  const { lead, payment, partner, config } = input;
  const partnerId = lead.partnerId;
  const skip = (reason: string): PaymentCommissionPlan => ({ kind: "skip", type: "commission.skipped", data: { paymentId: payment.paymentId, reason } });
  if (!partnerId) return skip("the lead has no partner");
  if (!partner) throw new Error("the partner's status is required to plan a commission");
  if (partner.id !== partnerId) throw new Error("partner status is for a different partner than the lead's");

  const customerSince = lead.customerSince ?? payment.confirmedAt;
  const ageMonths = customerAgeMonths(customerSince, payment.confirmedAt);
  let basisPoints = input.basisPoints;
  if (basisPoints === undefined) {
    const schedule = config.commission.rateSchedule;
    if (!schedule) throw new Error("no commission rate: set config.commission.rateSchedule or pass basisPoints");
    basisPoints = rateForCustomerAge(schedule, ageMonths).basisPoints;
  }
  const amountMinor = calculateCommissionMinor(payment.amountMinor, basisPoints);
  if (amountMinor === 0) return skip("the commission rounds to zero");

  const policy = config.partners?.onDeactivation ?? defaultPartnerDeactivationPolicy;
  const houseAccountId = config.partners?.houseAccountId ?? "house";
  if (houseAccountId === partnerId) throw new Error("a partner cannot share an id with the house account");

  if (!partner.active && policy.futurePayments === "forfeit") {
    return {
      kind: "forfeit", type: "commission.forfeited",
      data: { paymentId: payment.paymentId, partnerId, reason: "partner inactive; workspace policy forfeits new commission" },
    };
  }

  const releaseAt = commissionReleaseAt(payment.confirmedAt, input.holdDays ?? config.commission.holdDays);
  const base = { payoutId: input.payoutId, amountMinor, currency: payment.currency, releaseAt, paymentId: payment.paymentId, basisPoints, customerAgeMonths: ageMonths };
  if (!partner.active && policy.futurePayments === "house") {
    return {
      kind: "hold", type: "commission.held",
      data: { ...base, partnerId: houseAccountId, beneficiary: "house", originalPartnerId: partnerId, beneficiaryReason: "partner inactive; workspace policy sends new commission to the house account" },
    };
  }
  return {
    kind: "hold", type: "commission.held",
    data: {
      ...base, partnerId, beneficiary: "partner", originalPartnerId: partnerId,
      ...(partner.active ? {} : { beneficiaryReason: "partner inactive; workspace policy keeps paying the partner" }),
    },
  };
}

export type DeactivationEvent =
  | { type: "commission.transferred"; data: EventData<"commission.transferred"> }
  | { type: "commission.voided"; data: EventData<"commission.voided"> };

/**
 * The events to append when a partner is deactivated, per lead, under the
 * workspace's heldLines policy. Only lines still owed to that partner and
 * not yet paid are touched. "keep" returns nothing.
 */
export function planPartnerDeactivation(input: {
  leads: readonly LeadState[];
  partnerId: string;
  config: TandemConfig;
  reason?: string;
}): { leadId: string; events: DeactivationEvent[] }[] {
  const policy = input.config.partners?.onDeactivation ?? defaultPartnerDeactivationPolicy;
  const houseAccountId = input.config.partners?.houseAccountId ?? "house";
  if (!input.partnerId.trim()) throw new Error("partnerId is required");
  if (input.partnerId === houseAccountId) throw new Error("the house account cannot be deactivated");
  if (policy.heldLines === "keep") return [];
  const reason = input.reason?.trim() || "partner deactivated";
  const plans: { leadId: string; events: DeactivationEvent[] }[] = [];
  for (const lead of input.leads) {
    const events: DeactivationEvent[] = [];
    for (const line of lead.commissions) {
      if (line.beneficiary !== "partner" || line.partnerId !== input.partnerId) continue;
      if (line.status !== "held" && line.status !== "eligible" && line.status !== "approved") continue;
      events.push(policy.heldLines === "house"
        ? { type: "commission.transferred", data: { payoutId: line.payoutId, toPartnerId: houseAccountId, reason } }
        : { type: "commission.voided", data: { payoutId: line.payoutId, reason } });
    }
    if (events.length > 0) plans.push({ leadId: lead.leadId, events });
  }
  return plans;
}

export type PartnerBalance = {
  heldMinor: number;
  eligibleMinor: number;
  approvedMinor: number;
  paidMinor: number;
  /** Clawbacks requested minus recovered: what the partner still owes. */
  clawbackOwedMinor: number;
};

/** Totals for everything currently owed to (or by) one account, per
 * currency. The raw material for a statement; not a statement itself. */
export function partnerBalance(leads: readonly LeadState[], partnerId: string): Record<string, PartnerBalance> {
  const totals: Record<string, PartnerBalance> = {};
  for (const lead of leads) {
    for (const line of lead.commissions) {
      if (line.partnerId !== partnerId) continue;
      const t = (totals[line.currency] ??= { heldMinor: 0, eligibleMinor: 0, approvedMinor: 0, paidMinor: 0, clawbackOwedMinor: 0 });
      if (line.status === "held") t.heldMinor += line.amountMinor;
      else if (line.status === "eligible") t.eligibleMinor += line.amountMinor;
      else if (line.status === "approved") t.approvedMinor += line.amountMinor;
      else if (line.status === "paid") t.paidMinor += line.amountMinor;
      if (line.clawback) t.clawbackOwedMinor += line.clawback.amountMinor - line.clawback.recoveredMinor;
    }
  }
  return totals;
}
