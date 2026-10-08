import type { TandemConfig } from "./tandem.config.js";

export const tandemLeadStatuses = [
  "Automated_Setup", "Manual_Review", "Won", "Commission_Hold",
  "Commission_Eligible", "Commission_Paid", "Lost", "Refunded",
] as const;

export type TandemLeadStatus = (typeof tandemLeadStatuses)[number];

/** The sales-cycle pipeline (New -> ... -> Closed_Won/Closed_Lost), a
 * separate axis from TandemLeadStatus (the commission pipeline: Won ->
 * Commission_Hold -> ... -> Commission_Paid). The two were previously
 * conflated -- the Kanban grouped by TandemLeadStatus while the sales stage
 * only ever lived inside a Trail activity entry, unqueryable on the lead
 * itself. Defined here, not in trail.ts, so both modules share one
 * definition without trail.ts depending on domain.ts's event log or vice
 * versa; trail.ts re-exports these under its existing names. */
export const leadSalesStages = [
  "New", "Contacted", "Qualified", "Negotiating", "Closed_Won", "Closed_Lost",
] as const;
export type LeadSalesStage = (typeof leadSalesStages)[number];
export type QualificationStatus = Extract<TandemLeadStatus, "Automated_Setup" | "Manual_Review">;
export type InboundLead = {
  companyName: string;
  contactPhone: string;
  qualificationMetric: number;
  partnerId?: string;
  productTag: string;
  attributes?: Record<string, unknown>;
};
export type LeadQualification = {
  status: QualificationStatus;
  requiresHumanReview: boolean;
  shouldStartCheckout: boolean;
};

export function qualifyLead(lead: Pick<InboundLead, "qualificationMetric">, config: TandemConfig): LeadQualification {
  if (!Number.isSafeInteger(lead.qualificationMetric) || lead.qualificationMetric < 0) {
    throw new Error("qualificationMetric must be a non-negative safe integer");
  }
  const isAutomated = lead.qualificationMetric <= config.qualification.automatedSetupMaxQualificationMetric;
  return {
    status: isAutomated ? "Automated_Setup" : "Manual_Review",
    requiresHumanReview: !isAutomated,
    shouldStartCheckout: isAutomated,
  };
}

/** Tuple encoding avoids collisions when IDs contain separators. */
export function eventIdempotencyKey(source: string, eventId: string): string {
  const normalizedSource = source.trim().toLowerCase();
  const normalizedEventId = eventId.trim();
  if (!normalizedSource || !normalizedEventId) throw new Error("source and eventId are required for idempotency");
  return JSON.stringify([normalizedSource, normalizedEventId]);
}

/** Amounts are already in currency minor units; adapters resolve currency precision. */
export function assertMoney(amountMinor: number, currency: string): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("amountMinor must be a non-negative safe integer");
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter uppercase code");
}

/** Integer half-up rounding with no floating point monetary arithmetic. */
export function calculateCommissionMinor(amountMinor: number, basisPoints: number): number {
  assertMoney(amountMinor, "USD");
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new Error("basisPoints must be an integer from 0 to 10000");
  }
  return Number((BigInt(amountMinor) * BigInt(basisPoints) + BigInt(5_000)) / BigInt(10_000));
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(parsed)) {
    throw new Error("timestamp must be an ISO 8601 instant");
  }
  return parsed;
}

/** Snapshot this value in commission.held; old holds do not follow later config edits. */
export function commissionReleaseAt(paymentAt: string, holdDays: number): string {
  if (!Number.isSafeInteger(holdDays) || holdDays < 0) {
    throw new Error("holdDays must be a non-negative safe integer");
  }
  const releaseAt = instant(paymentAt) + holdDays * 86_400_000;
  if (!Number.isSafeInteger(releaseAt)) throw new Error("releaseAt is out of range");
  return new Date(releaseAt).toISOString();
}

type EventBase = {
  id: string;
  sequence: number;
  workspaceId: string;
  leadId: string;
  source: string;
  sourceEventId: string;
  occurredAt: string;
};

/** Who a commission line is owed to. "house" means the line was routed away
 * from the referring partner by the workspace's deactivation policy; the
 * referrer is still recorded as originalPartnerId. */
export type CommissionBeneficiary = "partner" | "house";

export type TandemEvent = EventBase & (
  | { type: "lead.created"; data: { companyName: string; qualificationMetric: number; qualification: QualificationStatus; partnerId?: string } }
  | { type: "lead.assigned"; data: { agentId: string; territoryId: string | null } }
  | { type: "lead.lost"; data: { reason: string } }
  | { type: "lead.stage_changed"; data: { salesStage: LeadSalesStage } }
  | { type: "conversion.confirmed"; data: Record<string, never> }
  /** paymentId is the provider's id for this payment (a Stripe invoice or
   * charge id). It is what lets a lead hold many payments and makes a
   * retried webhook harmless. 0.1 events have none and are treated as
   * the lead's only payment. */
  | { type: "payment.confirmed"; data: { amountMinor: number; currency: string; paymentId?: string } }
  /** Without paymentId and amountMinor this is the 0.1 meaning: refund all
   * of the lead's only payment. With them it refunds part or all of one
   * payment. */
  | { type: "payment.refunded"; data: { reason: string; paymentId?: string; amountMinor?: number } }
  | { type: "commission.held"; data: {
      payoutId: string; partnerId: string; amountMinor: number; currency: string; releaseAt: string;
      paymentId?: string;
      beneficiary?: CommissionBeneficiary;
      originalPartnerId?: string;
      beneficiaryReason?: string;
      basisPoints?: number;
      customerAgeMonths?: number;
    } }
  | { type: "commission.eligible"; data: { payoutId: string } }
  | { type: "commission.approved"; data: { payoutId: string } }
  | { type: "commission.paid"; data: { payoutId: string; payoutReference: string } }
  | { type: "commission.voided"; data: { payoutId: string; reason: string } }
  | { type: "commission.adjusted"; data: { payoutId: string; newAmountMinor: number } }
  | { type: "commission.reinstated"; data: { payoutId: string; amountMinor: number; releaseAt: string } }
  | { type: "commission.clawback_requested"; data: { payoutId: string; amountMinor: number; reason: string } }
  /** No commission is owed on this payment, and why (for example the
   * referring partner is inactive and the policy is "forfeit"). */
  | { type: "commission.forfeited"; data: { paymentId: string; partnerId: string; reason: string } }
  /** An unpaid line moves to the house account. The line keeps its id and
   * history; an approved line goes back to eligible because the approval
   * was given for a different recipient. */
  | { type: "commission.transferred"; data: { payoutId: string; toPartnerId: string; reason: string } }
  /** Money owed back on a paid line has been recovered outside Tandem. */
  | { type: "commission.clawback_recovered"; data: { payoutId: string; amountMinor: number; reference: string } }
);

export type CommissionClawback = {
  amountMinor: number;
  reason: string;
  requestedAt: string;
  /** How much of amountMinor has been recovered so far. */
  recoveredMinor: number;
};

export type CommissionState = {
  payoutId: string;
  /** Who this line is owed to right now: the referring partner, or the
   * house account id after a transfer or a "house" policy. */
  partnerId: string;
  amountMinor: number;
  currency: string;
  releaseAt: string;
  status: "held" | "eligible" | "approved" | "paid" | "voided";
  /** Set once money already paid out needs to be recovered outside Tandem
   * (a Belay dispute upheld against a paid commission, or a refund that
   * arrives after payout). Tandem never reverses a real payment itself;
   * this is a record for the host app to act on. What is still owed is
   * amountMinor - recoveredMinor. Null whenever nothing is owed back. */
  clawback: CommissionClawback | null;
  /** The payment this line was earned on. */
  paymentId: string;
  beneficiary: CommissionBeneficiary;
  /** The partner who referred the customer, even if the line now belongs
   * to the house account. */
  originalPartnerId: string;
  beneficiaryReason: string | null;
  /** The rate and customer age the line was calculated with, when the
   * writer recorded them. Null on 0.1 lines. */
  basisPoints: number | null;
  customerAgeMonths: number | null;
  /** Commission removed by refunds after this line was paid. Internal to
   * the partial-refund arithmetic; already included in clawback. */
  refundClawbackMinor: number;
};

export type PaymentState = {
  paymentId: string;
  amountMinor: number;
  currency: string;
  confirmedAt: string;
  refundedMinor: number;
  /** True once every minor unit of the payment has been refunded. */
  refunded: boolean;
  /** Set when commission.forfeited recorded that no line is owed. */
  forfeited: { partnerId: string; reason: string } | null;
};

export type LeadState = {
  workspaceId: string;
  leadId: string;
  status: TandemLeadStatus;
  salesStage: LeadSalesStage;
  companyName: string;
  qualificationMetric: number;
  partnerId: string | null;
  agentId: string | null;
  territoryId: string | null;
  /** Every payment, in the order they were confirmed. */
  payments: PaymentState[];
  /** Every commission line, in the order they were created. */
  commissions: CommissionState[];
  /** When the customer's first payment was confirmed. Customer age, and so
   * the commission rate tier, is measured from here. */
  customerSince: string | null;
  /** 0.1 compatibility: the most recent payment. Prefer `payments`. */
  payment: { amountMinor: number; currency: string; confirmedAt: string; refunded: boolean } | null;
  /** 0.1 compatibility: the most recent commission line. Prefer `commissions`. */
  commission: CommissionState | null;
  lastSequence: number;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function requireTransition(condition: unknown, type: string): asserts condition {
  if (!condition) throw new Error(`invalid transition: ${type}`);
}
function currentLead(state: LeadState | null): LeadState {
  if (state === null) throw new Error("lead has not been created");
  return state;
}

/** round_half_up(value * numerator / denominator) in exact integer math. */
export function proportionMinor(value: number, numerator: number, denominator: number): number {
  if (![value, numerator, denominator].every(Number.isSafeInteger) || value < 0 || numerator < 0 || denominator <= 0) {
    throw new Error("proportionMinor needs non-negative safe integers and a positive denominator");
  }
  const twice = BigInt(2) * BigInt(value) * BigInt(numerator);
  return Number((twice + BigInt(denominator)) / (BigInt(2) * BigInt(denominator)));
}

/** The commission pipeline status of a converted lead with at least one
 * payment, derived from its lines. Work an operator can act on comes first.
 * For one payment and one line this is exactly the 0.1 status sequence. */
export function deriveLeadStatus(payments: readonly PaymentState[], lines: readonly CommissionState[]): TandemLeadStatus {
  if (payments.length > 0 && payments.every((p) => p.refunded)) return "Refunded";
  if (lines.some((l) => l.status === "eligible" || l.status === "approved")) return "Commission_Eligible";
  if (lines.some((l) => l.status === "held")) return "Commission_Hold";
  if (lines.some((l) => l.status === "paid")) return "Commission_Paid";
  return "Won";
}

function withMoney(base: LeadState, payments: PaymentState[], commissions: CommissionState[], lastSequence: number): LeadState {
  const last = payments[payments.length - 1];
  return {
    ...base,
    status: deriveLeadStatus(payments, commissions),
    payments,
    commissions,
    customerSince: payments[0]?.confirmedAt ?? null,
    payment: last ? { amountMinor: last.amountMinor, currency: last.currency, confirmedAt: last.confirmedAt, refunded: last.refunded } : null,
    commission: commissions[commissions.length - 1] ?? null,
    lastSequence,
  };
}

function findLine(state: LeadState, payoutId: string, type: string): { lines: CommissionState[]; line: CommissionState; payment: PaymentState } {
  const lines = state.commissions.map((l) => ({ ...l }));
  const line = lines.find((l) => l.payoutId === payoutId);
  requireTransition(line !== undefined, type);
  const payment = state.payments.find((p) => p.paymentId === line.paymentId);
  requireTransition(payment !== undefined, type);
  return { lines, line, payment };
}

const unpaidOpen = (status: CommissionState["status"]) => status === "held" || status === "eligible" || status === "approved";
const POST_CONVERSION: readonly TandemLeadStatus[] = ["Won", "Commission_Hold", "Commission_Eligible", "Commission_Paid", "Refunded"];

/** Rebuild one lead in append order, ignoring exact delivery retries. */
export function replayLeadEvents(events: readonly TandemEvent[], workspaceId: string, leadId: string): LeadState | null {
  const seenIds = new Map<string, string>();
  const seenSources = new Map<string, string>();
  let state: LeadState | null = null;
  let lastSequence = 0;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.workspaceId !== workspaceId || event.leadId !== leadId) throw new Error("event belongs to another lead or workspace");
    if (!event.id.trim() || !Number.isSafeInteger(event.sequence) || event.sequence <= 0) throw new Error("event id and positive sequence are required");
    instant(event.occurredAt);
    const sourceKey = eventIdempotencyKey(event.source, event.sourceEventId);
    const fingerprint = canonical(event);
    const prior = seenIds.get(event.id);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error("conflicting duplicate event id");
      continue;
    }
    if (seenSources.has(sourceKey)) throw new Error("conflicting duplicate source event id");
    if (event.sequence <= lastSequence) throw new Error("duplicate or out-of-order event sequence");
    seenIds.set(event.id, fingerprint);
    seenSources.set(sourceKey, event.id);
    lastSequence = event.sequence;
    switch (event.type) {
      case "lead.created":
        requireTransition(state === null, event.type);
        if (!event.data.companyName.trim() || !Number.isSafeInteger(event.data.qualificationMetric) || event.data.qualificationMetric < 0) throw new Error("invalid lead creation data");
        if (event.data.qualification !== "Automated_Setup" && event.data.qualification !== "Manual_Review") throw new Error("invalid qualification");
        state = {
          workspaceId, leadId, status: event.data.qualification, salesStage: "New", companyName: event.data.companyName,
          qualificationMetric: event.data.qualificationMetric, partnerId: event.data.partnerId ?? null, agentId: null, territoryId: null,
          payments: [], commissions: [], customerSince: null, payment: null, commission: null, lastSequence,
        };
        break;
      case "lead.stage_changed":
        requireTransition(state !== null, event.type);
        if (!leadSalesStages.includes(event.data.salesStage)) throw new Error("invalid salesStage");
        state = { ...currentLead(state), salesStage: event.data.salesStage, lastSequence };
        break;
      case "lead.assigned":
        requireTransition(state !== null && state.status !== "Lost" && state.status !== "Refunded", event.type);
        if (!event.data.agentId.trim()) throw new Error("agentId is required");
        state = { ...currentLead(state), agentId: event.data.agentId, territoryId: event.data.territoryId, lastSequence };
        break;
      case "lead.lost":
        requireTransition(state !== null && state.payments.length === 0 && state.status !== "Lost", event.type);
        state = { ...currentLead(state), status: "Lost", lastSequence };
        break;
      case "conversion.confirmed":
        requireTransition(state !== null && (state.status === "Automated_Setup" || state.status === "Manual_Review"), event.type);
        state = { ...currentLead(state), status: "Won", lastSequence };
        break;
      case "payment.confirmed": {
        requireTransition(state !== null && POST_CONVERSION.includes(state.status), event.type);
        assertMoney(event.data.amountMinor, event.data.currency);
        if (event.data.amountMinor === 0) throw new Error("payment amount must be positive");
        if (event.data.paymentId !== undefined && (typeof event.data.paymentId !== "string" || !event.data.paymentId.trim())) throw new Error("paymentId must be a non-empty string");
        const paymentId = event.data.paymentId?.trim() ?? `legacy:${event.id}`;
        const s = currentLead(state);
        if (s.payments.some((p) => p.paymentId === paymentId)) throw new Error("payment already recorded");
        if (s.payments.length > 0 && s.payments[0].currency !== event.data.currency) throw new Error("all payments on a lead must use the same currency");
        const payments = [...s.payments, { paymentId, amountMinor: event.data.amountMinor, currency: event.data.currency, confirmedAt: event.occurredAt, refundedMinor: 0, refunded: false, forfeited: null }];
        state = withMoney(s, payments, s.commissions, lastSequence);
        break;
      }
      case "payment.refunded": {
        requireTransition(state !== null && state.payments.length > 0, event.type);
        const s = currentLead(state);
        const payments = s.payments.map((p) => ({ ...p }));
        let target: PaymentState | undefined;
        if (event.data.paymentId !== undefined) {
          target = payments.find((p) => p.paymentId === event.data.paymentId);
        } else if (payments.length === 1) {
          target = payments[0];
        } else {
          throw new Error("paymentId is required to refund a lead with more than one payment");
        }
        requireTransition(target !== undefined && !target.refunded, event.type);
        const remaining = target.amountMinor - target.refundedMinor;
        const refundMinor = event.data.amountMinor ?? remaining;
        if (!Number.isSafeInteger(refundMinor) || refundMinor <= 0 || refundMinor > remaining) {
          throw new Error("refund amountMinor must be a positive integer not exceeding what is left of the payment");
        }
        // The exact 0.1 rule, kept so every 0.1 history replays the same way.
        const legacyShape = event.data.amountMinor === undefined && event.data.paymentId === undefined && target.refundedMinor === 0;
        const lines = s.commissions.map((l) => ({ ...l }));
        const line = lines.find((l) => l.paymentId === target.paymentId);
        if (line && legacyShape) {
          if (line.status === "paid") {
            line.clawback = line.clawback ?? { amountMinor: line.amountMinor, reason: "payment refunded after payout", requestedAt: event.occurredAt, recoveredMinor: 0 };
          } else {
            line.status = "voided";
          }
        } else if (line && line.status !== "voided") {
          if (line.status === "paid") {
            const kept = line.amountMinor - line.refundClawbackMinor;
            const reduction = proportionMinor(kept, refundMinor, remaining);
            if (reduction > 0) {
              line.refundClawbackMinor += reduction;
              const owed = Math.min(line.amountMinor, (line.clawback?.amountMinor ?? 0) + reduction);
              line.clawback = {
                amountMinor: owed,
                reason: line.clawback?.reason ?? "payment refunded after payout",
                requestedAt: line.clawback?.requestedAt ?? event.occurredAt,
                recoveredMinor: line.clawback?.recoveredMinor ?? 0,
              };
            }
          } else {
            const reduction = proportionMinor(line.amountMinor, refundMinor, remaining);
            if (reduction >= line.amountMinor) line.status = "voided";
            else line.amountMinor -= reduction;
          }
        }
        target.refundedMinor += refundMinor;
        target.refunded = target.refundedMinor === target.amountMinor;
        state = withMoney(s, payments, lines, lastSequence);
        break;
      }
      case "commission.held": {
        requireTransition(state !== null && state.payments.length > 0 && POST_CONVERSION.includes(state.status), event.type);
        const s = currentLead(state);
        const d = event.data;
        let payment: PaymentState | undefined;
        if (d.paymentId !== undefined) payment = s.payments.find((p) => p.paymentId === d.paymentId);
        else if (s.payments.length === 1) payment = s.payments[0];
        else throw new Error("paymentId is required to hold a commission on a lead with more than one payment");
        requireTransition(payment !== undefined && !payment.refunded && payment.forfeited === null, event.type);
        requireTransition(!s.commissions.some((l) => l.paymentId === payment.paymentId), event.type);
        if (s.commissions.some((l) => l.payoutId === d.payoutId)) throw new Error("payoutId is already used on this lead");
        assertMoney(d.amountMinor, d.currency);
        if (!d.payoutId.trim() || !d.partnerId.trim() || d.amountMinor === 0 || d.amountMinor > payment.amountMinor - payment.refundedMinor || d.currency !== payment.currency || instant(d.releaseAt) < instant(payment.confirmedAt)) throw new Error("invalid commission hold");
        const beneficiary = d.beneficiary ?? "partner";
        if (beneficiary !== "partner" && beneficiary !== "house") throw new Error("beneficiary must be partner or house");
        const originalPartnerId = d.originalPartnerId ?? d.partnerId;
        if (!originalPartnerId.trim()) throw new Error("originalPartnerId must not be empty");
        if (beneficiary === "partner" && originalPartnerId !== d.partnerId) throw new Error("a partner line is owed to the partner who referred the customer");
        if (beneficiary === "house" && (d.originalPartnerId === undefined || originalPartnerId === d.partnerId)) throw new Error("a house line must name the original partner and a different house account");
        if (d.basisPoints !== undefined && (!Number.isSafeInteger(d.basisPoints) || d.basisPoints < 0 || d.basisPoints > 10_000)) throw new Error("basisPoints must be an integer from 0 to 10000");
        if (d.customerAgeMonths !== undefined && (!Number.isSafeInteger(d.customerAgeMonths) || d.customerAgeMonths < 0)) throw new Error("customerAgeMonths must be a non-negative integer");
        const line: CommissionState = {
          payoutId: d.payoutId, partnerId: d.partnerId, amountMinor: d.amountMinor, currency: d.currency, releaseAt: d.releaseAt,
          status: "held", clawback: null, paymentId: payment.paymentId, beneficiary, originalPartnerId,
          beneficiaryReason: d.beneficiaryReason?.trim() || null, basisPoints: d.basisPoints ?? null,
          customerAgeMonths: d.customerAgeMonths ?? null, refundClawbackMinor: 0,
        };
        state = withMoney(s, s.payments, [...s.commissions, line], lastSequence);
        break;
      }
      case "commission.forfeited": {
        requireTransition(state !== null, event.type);
        const s = currentLead(state);
        const payments = s.payments.map((p) => ({ ...p }));
        const payment = payments.find((p) => p.paymentId === event.data.paymentId);
        requireTransition(payment !== undefined && payment.forfeited === null && !s.commissions.some((l) => l.paymentId === payment.paymentId), event.type);
        if (!event.data.partnerId.trim() || !event.data.reason.trim()) throw new Error("partnerId and reason are required");
        payment.forfeited = { partnerId: event.data.partnerId, reason: event.data.reason.trim() };
        state = withMoney(s, payments, s.commissions, lastSequence);
        break;
      }
      case "commission.eligible": {
        requireTransition(state !== null, event.type);
        const { lines, line, payment } = findLine(state, event.data.payoutId, event.type);
        requireTransition(line.status === "held" && !payment.refunded && instant(event.occurredAt) >= instant(line.releaseAt), event.type);
        line.status = "eligible";
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      case "commission.approved": {
        requireTransition(state !== null, event.type);
        const { lines, line } = findLine(state, event.data.payoutId, event.type);
        requireTransition(line.status === "eligible", event.type);
        line.status = "approved";
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      case "commission.paid": {
        requireTransition(state !== null, event.type);
        const { lines, line } = findLine(state, event.data.payoutId, event.type);
        requireTransition(line.status === "approved" && !!event.data.payoutReference.trim(), event.type);
        line.status = "paid";
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      case "commission.voided": {
        requireTransition(state !== null, event.type);
        const { lines, line } = findLine(state, event.data.payoutId, event.type);
        requireTransition(unpaidOpen(line.status), event.type);
        line.status = "voided";
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      // The next three exist to let a caller (typically resolving a Belay
      // dispute) act on an outcome. Tandem never appends these itself; see
      // belay.ts's dispute.resolved for the equivalent non-enforcement split.
      case "commission.adjusted": {
        requireTransition(state !== null, event.type);
        const { lines, line, payment } = findLine(state, event.data.payoutId, event.type);
        requireTransition(unpaidOpen(line.status), event.type);
        assertMoney(event.data.newAmountMinor, line.currency);
        if (event.data.newAmountMinor === 0 || event.data.newAmountMinor > payment.amountMinor - payment.refundedMinor) throw new Error("invalid adjusted commission amount");
        line.amountMinor = event.data.newAmountMinor;
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      case "commission.reinstated": {
        requireTransition(state !== null, event.type);
        const { lines, line, payment } = findLine(state, event.data.payoutId, event.type);
        requireTransition(!payment.refunded && line.status === "voided", event.type);
        assertMoney(event.data.amountMinor, line.currency);
        if (event.data.amountMinor === 0 || event.data.amountMinor > payment.amountMinor - payment.refundedMinor || instant(event.data.releaseAt) < instant(payment.confirmedAt)) {
          throw new Error("invalid commission reinstatement");
        }
        Object.assign(line, { status: "held", amountMinor: event.data.amountMinor, releaseAt: event.data.releaseAt, clawback: null, refundClawbackMinor: 0 });
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      case "commission.clawback_requested": {
        requireTransition(state !== null, event.type);
        const { lines, line } = findLine(state, event.data.payoutId, event.type);
        requireTransition(line.status === "paid", event.type);
        const already = line.clawback?.amountMinor ?? 0;
        if (!Number.isSafeInteger(event.data.amountMinor) || event.data.amountMinor <= 0 || already + event.data.amountMinor > line.amountMinor) {
          throw new Error("clawback amountMinor must be a positive integer, and the total clawback cannot exceed the paid amount");
        }
        if (!event.data.reason.trim()) throw new Error("reason is required");
        line.clawback = line.clawback
          ? { ...line.clawback, amountMinor: already + event.data.amountMinor }
          : { amountMinor: event.data.amountMinor, reason: event.data.reason.trim(), requestedAt: event.occurredAt, recoveredMinor: 0 };
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      case "commission.clawback_recovered": {
        requireTransition(state !== null, event.type);
        const { lines, line } = findLine(state, event.data.payoutId, event.type);
        requireTransition(line.status === "paid" && line.clawback !== null, event.type);
        const clawback = line.clawback;
        if (!Number.isSafeInteger(event.data.amountMinor) || event.data.amountMinor <= 0 || clawback.recoveredMinor + event.data.amountMinor > clawback.amountMinor) {
          throw new Error("recovered amountMinor must be a positive integer, and cannot exceed what is still owed");
        }
        if (!event.data.reference.trim()) throw new Error("reference is required");
        line.clawback = { ...clawback, recoveredMinor: clawback.recoveredMinor + event.data.amountMinor };
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      case "commission.transferred": {
        requireTransition(state !== null, event.type);
        const { lines, line } = findLine(state, event.data.payoutId, event.type);
        requireTransition(unpaidOpen(line.status) && line.beneficiary === "partner", event.type);
        const to = event.data.toPartnerId.trim();
        if (!to || to === line.partnerId) throw new Error("toPartnerId must be a different, non-empty account");
        if (!event.data.reason.trim()) throw new Error("reason is required");
        Object.assign(line, {
          partnerId: to, beneficiary: "house", beneficiaryReason: event.data.reason.trim(),
          status: line.status === "approved" ? "eligible" : line.status,
        });
        state = withMoney(state, state.payments, lines, lastSequence);
        break;
      }
      default:
        throw new Error(`unsupported event type: ${(event as { type: string }).type}`);
    }
  }
  return state;
}
