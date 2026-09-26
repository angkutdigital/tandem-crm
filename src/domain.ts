import type { TandemConfig } from "./tandem.config.js";

export const tandemLeadStatuses = [
  "Automated_Setup", "Manual_Review", "Won", "Commission_Hold",
  "Commission_Eligible", "Commission_Paid", "Lost", "Refunded",
] as const;

export type TandemLeadStatus = (typeof tandemLeadStatuses)[number];
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

export type TandemEvent = EventBase & (
  | { type: "lead.created"; data: { companyName: string; qualificationMetric: number; qualification: QualificationStatus; partnerId?: string } }
  | { type: "lead.assigned"; data: { agentId: string; territoryId: string | null } }
  | { type: "lead.lost"; data: { reason: string } }
  | { type: "conversion.confirmed"; data: Record<string, never> }
  | { type: "payment.confirmed"; data: { amountMinor: number; currency: string } }
  | { type: "payment.refunded"; data: { reason: string } }
  | { type: "commission.held"; data: { payoutId: string; partnerId: string; amountMinor: number; currency: string; releaseAt: string } }
  | { type: "commission.eligible"; data: { payoutId: string } }
  | { type: "commission.approved"; data: { payoutId: string } }
  | { type: "commission.paid"; data: { payoutId: string; payoutReference: string } }
  | { type: "commission.voided"; data: { payoutId: string; reason: string } }
  | { type: "commission.adjusted"; data: { payoutId: string; newAmountMinor: number } }
  | { type: "commission.reinstated"; data: { payoutId: string; amountMinor: number; releaseAt: string } }
  | { type: "commission.clawback_requested"; data: { payoutId: string; amountMinor: number; reason: string } }
);

export type CommissionState = {
  payoutId: string;
  partnerId: string;
  amountMinor: number;
  currency: string;
  releaseAt: string;
  status: "held" | "eligible" | "approved" | "paid" | "voided";
  /** Set once money already paid out needs to be recovered outside Tandem
   * (a Coaster dispute upheld against a paid commission, or a refund that
   * arrives after payout). Tandem never reverses a real payment itself;
   * this is a record for the host app to act on (deduct a future payout,
   * invoice the agent, etc.), the same non-enforcement split as everywhere
   * else money is involved. Null whenever nothing is owed back. */
  clawback: { amountMinor: number; reason: string; requestedAt: string } | null;
};
export type LeadState = {
  workspaceId: string;
  leadId: string;
  status: TandemLeadStatus;
  companyName: string;
  qualificationMetric: number;
  partnerId: string | null;
  agentId: string | null;
  territoryId: string | null;
  payment: { amountMinor: number; currency: string; confirmedAt: string; refunded: boolean } | null;
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
        state = { workspaceId, leadId, status: event.data.qualification, companyName: event.data.companyName, qualificationMetric: event.data.qualificationMetric, partnerId: event.data.partnerId ?? null, agentId: null, territoryId: null, payment: null, commission: null, lastSequence };
        break;
      case "lead.assigned":
        requireTransition(state !== null && state.status !== "Lost" && state.status !== "Refunded", event.type);
        if (!event.data.agentId.trim()) throw new Error("agentId is required");
        state = { ...currentLead(state), agentId: event.data.agentId, territoryId: event.data.territoryId, lastSequence };
        break;
      case "lead.lost":
        requireTransition(state !== null && !state.payment && state.status !== "Lost", event.type);
        state = { ...currentLead(state), status: "Lost", lastSequence };
        break;
      case "conversion.confirmed":
        requireTransition(state !== null && (state.status === "Automated_Setup" || state.status === "Manual_Review"), event.type);
        state = { ...currentLead(state), status: "Won", lastSequence };
        break;
      case "payment.confirmed":
        requireTransition(state !== null && state.status === "Won" && !state.payment, event.type);
        assertMoney(event.data.amountMinor, event.data.currency);
        if (event.data.amountMinor === 0) throw new Error("payment amount must be positive");
        state = { ...currentLead(state), payment: { ...event.data, confirmedAt: event.occurredAt, refunded: false }, lastSequence };
        break;
      case "payment.refunded": {
        requireTransition(state !== null && state.payment !== null && !state.payment.refunded, event.type);
        const priorCommission: CommissionState | null = currentLead(state).commission;
        // A commission already paid is real money that already moved: Tandem cannot
        // undo the payment itself, so a refund arriving after payout records a
        // clawback obligation instead of voiding it (voiding would falsely claim
        // the money never went out). Anything not yet paid never left the hold, so
        // it can just be voided, same as before this refund arrived.
        const nextCommission: CommissionState | null = priorCommission === null
          ? null
          : priorCommission.status === "paid"
            ? { ...priorCommission, clawback: priorCommission.clawback ?? { amountMinor: priorCommission.amountMinor, reason: "payment refunded after payout", requestedAt: event.occurredAt } }
            : { ...priorCommission, status: "voided" as const };
        state = { ...currentLead(state), status: "Refunded", payment: { ...currentLead(state).payment!, refunded: true }, commission: nextCommission, lastSequence };
        break;
      }
      case "commission.held":
        requireTransition(state !== null && state.payment !== null && !state.payment.refunded && state.commission === null && state.status === "Won", event.type);
        assertMoney(event.data.amountMinor, event.data.currency);
        if (!event.data.payoutId.trim() || !event.data.partnerId.trim() || event.data.amountMinor === 0 || event.data.amountMinor > state.payment.amountMinor || event.data.currency !== state.payment.currency || instant(event.data.releaseAt) < instant(state.payment.confirmedAt)) throw new Error("invalid commission hold");
        state = { ...currentLead(state), status: "Commission_Hold", commission: { ...event.data, status: "held", clawback: null }, lastSequence };
        break;
      case "commission.eligible":
        requireTransition(state !== null && state.commission?.status === "held" && !state.payment?.refunded && state.commission.payoutId === event.data.payoutId && instant(event.occurredAt) >= instant(state.commission.releaseAt), event.type);
        state = { ...currentLead(state), status: "Commission_Eligible", commission: { ...currentLead(state).commission!, status: "eligible" }, lastSequence };
        break;
      case "commission.approved":
        requireTransition(state !== null && state.commission?.status === "eligible" && state.commission.payoutId === event.data.payoutId, event.type);
        state = { ...currentLead(state), commission: { ...currentLead(state).commission!, status: "approved" }, lastSequence };
        break;
      case "commission.paid":
        requireTransition(state !== null && state.commission?.status === "approved" && state.commission.payoutId === event.data.payoutId && !!event.data.payoutReference.trim(), event.type);
        state = { ...currentLead(state), status: "Commission_Paid", commission: { ...currentLead(state).commission!, status: "paid" }, lastSequence };
        break;
      case "commission.voided":
        requireTransition(state !== null && state.commission !== null && ["held", "eligible", "approved"].includes(state.commission.status) && state.commission.payoutId === event.data.payoutId, event.type);
        state = { ...currentLead(state), status: "Won", commission: { ...currentLead(state).commission!, status: "voided" }, lastSequence };
        break;
      // The next three exist to let a caller (typically resolving a Coaster
      // dispute) act on an outcome. Tandem never appends these itself; see
      // coaster.ts's dispute.resolved for the equivalent non-enforcement split.
      case "commission.adjusted":
        requireTransition(state !== null && state.commission !== null && ["held", "eligible", "approved"].includes(state.commission.status) && state.commission.payoutId === event.data.payoutId, event.type);
        assertMoney(event.data.newAmountMinor, currentLead(state).commission!.currency);
        if (event.data.newAmountMinor === 0 || event.data.newAmountMinor > currentLead(state).payment!.amountMinor) throw new Error("invalid adjusted commission amount");
        state = { ...currentLead(state), commission: { ...currentLead(state).commission!, amountMinor: event.data.newAmountMinor }, lastSequence };
        break;
      case "commission.reinstated":
        requireTransition(state !== null && state.payment !== null && !state.payment.refunded && state.commission?.status === "voided" && state.commission.payoutId === event.data.payoutId, event.type);
        assertMoney(event.data.amountMinor, currentLead(state).commission!.currency);
        if (event.data.amountMinor === 0 || event.data.amountMinor > currentLead(state).payment!.amountMinor || instant(event.data.releaseAt) < instant(currentLead(state).payment!.confirmedAt)) {
          throw new Error("invalid commission reinstatement");
        }
        state = {
          ...currentLead(state), status: "Commission_Hold",
          commission: { ...currentLead(state).commission!, status: "held", amountMinor: event.data.amountMinor, releaseAt: event.data.releaseAt, clawback: null },
          lastSequence,
        };
        break;
      case "commission.clawback_requested":
        requireTransition(state !== null && state.commission?.status === "paid" && state.commission.payoutId === event.data.payoutId && state.commission.clawback === null, event.type);
        if (!Number.isSafeInteger(event.data.amountMinor) || event.data.amountMinor <= 0 || event.data.amountMinor > currentLead(state).commission!.amountMinor) {
          throw new Error("clawback amountMinor must be a positive integer not exceeding the paid amount");
        }
        if (!event.data.reason.trim()) throw new Error("reason is required");
        state = {
          ...currentLead(state),
          commission: { ...currentLead(state).commission!, clawback: { amountMinor: event.data.amountMinor, reason: event.data.reason.trim(), requestedAt: event.occurredAt } },
          lastSequence,
        };
        break;
      default:
        throw new Error(`unsupported event type: ${(event as { type: string }).type}`);
    }
  }
  return state;
}
