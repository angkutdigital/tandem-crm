import { eventIdempotencyKey, leadSalesStages, type LeadSalesStage } from "./domain.js";

/** Kept deliberately small and free-text-first: this is a lightweight
 * activity log for an agent working a lead, not a full CRM object model.
 * If a real deployment needs more structure than this (a formal objection
 * taxonomy, multiple contacts per lead, etc.), that belongs in their own
 * app's schema, not Terrain or here -- same split Belay and Ascent already
 * draw between "what Tandem tracks" and "what your product decides to do
 * with it." */
export const trailVisitChannels = ["phone", "physical", "email"] as const;
export type TrailVisitChannel = (typeof trailVisitChannels)[number];

/** Re-exported from domain.ts under Trail's existing names: sales stage is
 * now a first-class field on LeadState (see domain.ts's leadSalesStages),
 * not a concept Trail owns. Kept as an alias so existing callers of
 * trailSalesStages/TrailSalesStage don't need to change. */
export const trailSalesStages = leadSalesStages;
export type TrailSalesStage = LeadSalesStage;

type TrailEventBase = {
  id: string;
  sequence: number;
  workspaceId: string;
  leadId: string;
  entryId: string;
  source: string;
  sourceEventId: string;
  occurredAt: string;
};

export type TrailEvent = TrailEventBase & (
  | {
      type: "trail.visit_logged";
      data: {
        channel: TrailVisitChannel;
        confidenceRating: number;
        salesStage: TrailSalesStage;
        note: string;
      };
    }
  | {
      type: "trail.entry_corrected";
      data: {
        channel: TrailVisitChannel;
        confidenceRating: number;
        salesStage: TrailSalesStage;
        note: string;
      };
    }
  | { type: "trail.entry_retracted"; data: Record<string, never> }
);

export type TrailEntryState = {
  workspaceId: string;
  leadId: string;
  entryId: string;
  channel: TrailVisitChannel;
  confidenceRating: number;
  salesStage: TrailSalesStage;
  note: string;
  loggedAt: string;
  correctedAt: string | null;
  retracted: boolean;
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
function currentState(state: TrailEntryState | null): TrailEntryState {
  if (state === null) throw new Error("trail entry has not been logged");
  return state;
}
function validateFields(data: { channel: TrailVisitChannel; confidenceRating: number; salesStage: TrailSalesStage; note: string }): void {
  if (!trailVisitChannels.includes(data.channel)) throw new Error("channel must be one of phone, physical, email");
  if (!Number.isSafeInteger(data.confidenceRating) || data.confidenceRating < 1 || data.confidenceRating > 10) {
    throw new Error("confidenceRating must be an integer from 1 to 10");
  }
  if (!trailSalesStages.includes(data.salesStage)) throw new Error("invalid salesStage");
}

/** Rebuild one visit-report entry in append order, ignoring exact delivery
 * retries. Trail's "one lead" state is a list of these -- see
 * replayTrailEntries below, which folds every entryId separately. */
export function replayTrailEntryEvents(events: readonly TrailEvent[], workspaceId: string, leadId: string, entryId: string): TrailEntryState | null {
  const seenIds = new Map<string, string>();
  const seenSources = new Map<string, string>();
  let state: TrailEntryState | null = null;
  let lastSequence = 0;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.workspaceId !== workspaceId || event.leadId !== leadId || event.entryId !== entryId) {
      throw new Error("event belongs to another entry, lead, or workspace");
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
      case "trail.visit_logged":
        requireTransition(state === null, event.type);
        validateFields(event.data);
        if (!event.data.note.trim()) throw new Error("note is required");
        state = {
          workspaceId, leadId, entryId,
          channel: event.data.channel, confidenceRating: event.data.confidenceRating,
          salesStage: event.data.salesStage, note: event.data.note.trim(),
          loggedAt: event.occurredAt, correctedAt: null, retracted: false, lastSequence,
        };
        break;
      case "trail.entry_corrected":
        requireTransition(state !== null && !state.retracted, event.type);
        validateFields(event.data);
        if (!event.data.note.trim()) throw new Error("note is required");
        if (occurredAtMs < instant(currentState(state).loggedAt)) throw new Error("a correction cannot occur before the entry it corrects");
        state = {
          ...currentState(state),
          channel: event.data.channel, confidenceRating: event.data.confidenceRating,
          salesStage: event.data.salesStage, note: event.data.note.trim(),
          correctedAt: event.occurredAt, lastSequence,
        };
        break;
      case "trail.entry_retracted":
        requireTransition(state !== null && !state.retracted, event.type);
        state = { ...currentState(state), retracted: true, lastSequence };
        break;
      default:
        throw new Error(`unsupported event type: ${(event as { type: string }).type}`);
    }
  }
  return state;
}

/** Convenience over replayTrailEntryEvents: folds a lead's whole trail event
 * stream (every entryId mixed together, as tandem.trail_events stores them)
 * into one entry per id, in the order each was first logged. Retracted
 * entries are kept (not filtered out) so a caller can choose whether to
 * show them; they are simply flagged. */
export function replayTrailEntries(events: readonly TrailEvent[], workspaceId: string, leadId: string): TrailEntryState[] {
  const entryIds: string[] = [];
  const byEntry = new Map<string, TrailEvent[]>();
  for (const event of events) {
    if (!byEntry.has(event.entryId)) {
      byEntry.set(event.entryId, []);
      entryIds.push(event.entryId);
    }
    byEntry.get(event.entryId)!.push(event);
  }
  return entryIds
    .map((entryId) => replayTrailEntryEvents(byEntry.get(entryId)!, workspaceId, leadId, entryId))
    .filter((state): state is TrailEntryState => state !== null)
    .sort((a, b) => instant(a.loggedAt) - instant(b.loggedAt));
}
