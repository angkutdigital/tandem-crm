import { describe, expect, it } from "vitest";
import { replayTrailEntries, replayTrailEntryEvents, type TrailEvent, type TrailSalesStage, type TrailVisitChannel } from "./index.js";

const loggedAt = "2026-01-01T00:00:00.000Z";
function fact(sequence: number, type: TrailEvent["type"], data: TrailEvent["data"], occurredAt = loggedAt, entryId = "entry-1"): TrailEvent {
  return {
    id: `event-${sequence}`, sequence, workspaceId: "workspace-1", leadId: "lead-1", entryId,
    source: "test", sourceEventId: `source-${sequence}`, occurredAt, type, data,
  } as TrailEvent;
}
type VisitFields = { channel: TrailVisitChannel; confidenceRating: number; salesStage: TrailSalesStage; note: string };
const visit = (overrides: Partial<VisitFields> = {}): VisitFields => ({
  channel: "phone", confidenceRating: 6, salesStage: "Contacted", note: "Called, interested in pricing", ...overrides,
});
function logged(): TrailEvent[] {
  return [fact(1, "trail.visit_logged", visit())];
}
const replayEntry = (events: TrailEvent[], entryId = "entry-1") => replayTrailEntryEvents(events, "workspace-1", "lead-1", entryId);

describe("Trail deterministic replay", () => {
  it("logs a visit and replays by database sequence, ignoring an exact retry", () => {
    const events = [...logged(), fact(2, "trail.entry_corrected", visit({ confidenceRating: 8 }), "2026-01-02T00:00:00.000Z")];
    const result = replayEntry([events[1], events[0], { ...events[0] }]);
    expect(result).toMatchObject({ channel: "phone", confidenceRating: 8, salesStage: "Contacted", retracted: false, lastSequence: 2 });
  });
  it("rejects conflicting IDs, source IDs, sequences, and cross-entry facts", () => {
    const events = logged();
    expect(() => replayEntry([events[0], { ...events[0], occurredAt: "2026-02-01T00:00:00.000Z" } as TrailEvent])).toThrow("conflicting duplicate event id");
    expect(() => replayEntry([events[0], fact(2, "trail.entry_retracted", {}, loggedAt, "entry-1"), { ...events[0], id: "event-3", sourceEventId: events[0].sourceEventId }])).toThrow("conflicting duplicate source event id");
    expect(() => replayEntry([events[0], { ...fact(2, "trail.entry_retracted", {}), sequence: 1 }])).toThrow("duplicate or out-of-order event sequence");
    expect(() => replayEntry([{ ...events[0], entryId: "entry-2" }])).toThrow("another entry, lead, or workspace");
  });
  it("rejects a correction or retraction with nothing logged yet, and a double retraction", () => {
    expect(() => replayEntry([fact(1, "trail.entry_corrected", visit())])).toThrow("invalid transition");
    expect(() => replayEntry([fact(1, "trail.entry_retracted", {})])).toThrow("invalid transition");
    const retracted = [...logged(), fact(2, "trail.entry_retracted", {}, "2026-01-02T00:00:00.000Z")];
    expect(() => replayEntry([...retracted, fact(3, "trail.entry_corrected", visit(), "2026-01-03T00:00:00.000Z")])).toThrow("invalid transition");
    expect(() => replayEntry([...retracted, fact(3, "trail.entry_retracted", {}, "2026-01-03T00:00:00.000Z")])).toThrow("invalid transition");
  });
  it("rejects invalid fields on logging or correcting", () => {
    expect(() => replayEntry([fact(1, "trail.visit_logged", visit({ channel: "carrier_pigeon" as TrailVisitChannel }))])).toThrow("channel must be one of");
    expect(() => replayEntry([fact(1, "trail.visit_logged", visit({ confidenceRating: 0 }))])).toThrow("confidenceRating must be");
    expect(() => replayEntry([fact(1, "trail.visit_logged", visit({ confidenceRating: 11 }))])).toThrow("confidenceRating must be");
    expect(() => replayEntry([fact(1, "trail.visit_logged", visit({ salesStage: "Signed_In_Blood" as TrailSalesStage }))])).toThrow("invalid salesStage");
    expect(() => replayEntry([fact(1, "trail.visit_logged", visit({ note: "   " }))])).toThrow("note is required");
  });
  it("rejects a correction dated before the entry it corrects", () => {
    expect(() =>
      replayEntry([...logged(), fact(2, "trail.entry_corrected", visit(), "2025-12-31T00:00:00.000Z")])
    ).toThrow("cannot occur before");
  });
  it("rejects an unknown persisted event type during replay", () => {
    const unknown = { ...logged()[0], type: "trail.entry_deleted" } as unknown as TrailEvent;
    expect(() => replayEntry([unknown])).toThrow("unsupported event type: trail.entry_deleted");
  });
});

describe("Trail multi-entry projection", () => {
  it("folds a whole lead's trail into one entry per id, oldest first, keeping retracted entries flagged", () => {
    const events: TrailEvent[] = [
      fact(1, "trail.visit_logged", visit({ note: "First call" }), "2026-01-05T00:00:00.000Z", "entry-b"),
      fact(1, "trail.visit_logged", visit({ note: "Site visit" }), "2026-01-01T00:00:00.000Z", "entry-a"),
      fact(2, "trail.entry_retracted", {}, "2026-01-02T00:00:00.000Z", "entry-a"),
    ];
    const entries = replayTrailEntries(events, "workspace-1", "lead-1");
    expect(entries.map((e) => ({ entryId: e.entryId, note: e.note, retracted: e.retracted }))).toEqual([
      { entryId: "entry-a", note: "Site visit", retracted: true },
      { entryId: "entry-b", note: "First call", retracted: false },
    ]);
  });
});
