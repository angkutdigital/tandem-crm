import { eventIdempotencyKey } from "./domain.js";

export type DisputeCategory = "untracked" | "incorrect" | "declined";
export type DisputeOutcome = "upheld" | "dismissed";

type DisputeEventBase = {
  id: string;
  sequence: number;
  workspaceId: string;
  disputeId: string;
  leadId: string;
  payoutId: string;
  source: string;
  sourceEventId: string;
  occurredAt: string;
};

export type DisputeEvent = DisputeEventBase & (
  | {
      type: "dispute.opened";
      data: {
        payoutId: string;
        category: DisputeCategory;
        expectedAmountMinor: number | null;
        description: string;
        autoApproveAt: string;
      };
    }
  | { type: "dispute.queried"; data: { question: string } }
  | { type: "dispute.resolved"; data: { outcome: DisputeOutcome; note: string } }
);

export type DisputeState = {
  workspaceId: string;
  disputeId: string;
  leadId: string;
  payoutId: string;
  category: DisputeCategory;
  expectedAmountMinor: number | null;
  description: string;
  status: "open" | "queried" | "resolved";
  outcome: DisputeOutcome | null;
  autoApproveAt: string;
  lastSequence: number;
};

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(parsed)) {
    throw new Error("timestamp must be an ISO 8601 instant");
  }
  return parsed;
}

/** domain.ts does not export its canonicalizer; same rules keep duplicate-id fingerprints stable. */
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
function currentState(state: DisputeState | null): DisputeState {
  if (state === null) throw new Error("dispute has not been opened");
  return state;
}

/** Rebuild one dispute in append order, ignoring exact delivery retries. */
export function replayDisputeEvents(events: readonly DisputeEvent[], workspaceId: string, disputeId: string): DisputeState | null {
  const seenIds = new Map<string, string>();
  const seenSources = new Map<string, string>();
  let state: DisputeState | null = null;
  let lastSequence = 0;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.workspaceId !== workspaceId || event.disputeId !== disputeId) throw new Error("event belongs to another dispute or workspace");
    // leadId/payoutId are denormalized onto every event (for the table's own foreign keys
    // and RLS joins), not an independent grouping key, so they must stay constant for the
    // life of a dispute the same way domain.ts's events never change which lead they belong to.
    if (state !== null && (event.leadId !== state.leadId || event.payoutId !== state.payoutId)) {
      throw new Error("event belongs to another lead or payout");
    }
    if (!event.id.trim() || !Number.isSafeInteger(event.sequence) || event.sequence <= 0) throw new Error("event id and positive sequence are required");
    const occurredAtMs = instant(event.occurredAt);
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
      case "dispute.opened": {
        requireTransition(state === null, event.type);
        if (event.data.payoutId !== event.payoutId) throw new Error("payoutId in event data must match event.payoutId");
        if (!["untracked", "incorrect", "declined"].includes(event.data.category)) {
          throw new Error("category must be one of untracked, incorrect, declined");
        }
        if (!event.data.description.trim()) throw new Error("description is required");
        if (event.data.category === "incorrect") {
          if (!Number.isSafeInteger(event.data.expectedAmountMinor) || (event.data.expectedAmountMinor as number) < 0) {
            throw new Error("expectedAmountMinor must be a non-negative safe integer for incorrect disputes");
          }
        } else if (event.data.expectedAmountMinor !== null) {
          throw new Error("expectedAmountMinor must be null for non-incorrect disputes");
        }
        if (instant(event.data.autoApproveAt) <= occurredAtMs) throw new Error("autoApproveAt must be after occurredAt");
        state = {
          workspaceId, disputeId, leadId: event.leadId, payoutId: event.payoutId,
          category: event.data.category, expectedAmountMinor: event.data.expectedAmountMinor,
          description: event.data.description.trim(), status: "open", outcome: null,
          autoApproveAt: event.data.autoApproveAt, lastSequence,
        };
        break;
      }
      case "dispute.queried":
        requireTransition(state !== null && state.status === "open", event.type);
        if (!event.data.question.trim()) throw new Error("question is required");
        state = { ...currentState(state), status: "queried", lastSequence };
        break;
      case "dispute.resolved":
        requireTransition(state !== null && (state.status === "open" || state.status === "queried"), event.type);
        if (event.data.outcome !== "upheld" && event.data.outcome !== "dismissed") throw new Error("outcome must be upheld or dismissed");
        if (!event.data.note.trim()) throw new Error("note is required");
        state = { ...currentState(state), status: "resolved", outcome: event.data.outcome, lastSequence };
        break;
      default:
        throw new Error(`unsupported event type: ${(event as { type: string }).type}`);
    }
  }
  return state;
}

/** Snapshot this value in dispute.opened; open disputes do not follow later config edits.
 * Tandem does not hardcode a default window (75 days is Awin's own default, not a rule this
 * package enforces); the caller decides the day count, the same way routing.ts takes a
 * strategy instead of picking one itself. */
export function disputeAutoApproveAt(openedAt: string, autoApproveDays: number): string {
  const openedAtMs = instant(openedAt);
  if (!Number.isSafeInteger(autoApproveDays) || autoApproveDays < 0) {
    throw new Error("autoApproveDays must be a non-negative safe integer");
  }
  const autoApproveAt = openedAtMs + autoApproveDays * 86_400_000;
  if (!Number.isSafeInteger(autoApproveAt)) throw new Error("autoApproveAt is out of range");
  return new Date(autoApproveAt).toISOString();
}

/** A pure decision for callers that need to show an overdue state before a
 * scheduler runs. The vendor-neutral database scheduler in migration 015 can
 * resolve due disputes; this function itself remains deterministic and has no
 * clock, database, or deployment dependency. */
export function isDisputeOverdue(state: DisputeState | null, nowIso: string): boolean {
  if (state === null || state.status === "resolved") return false;
  return instant(nowIso) >= instant(state.autoApproveAt);
}
