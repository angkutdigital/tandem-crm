import { describe, expect, it } from "vitest";
import {
  disputeAutoApproveAt,
  isDisputeOverdue,
  replayDisputeEvents,
  type DisputeEvent,
  type DisputeState,
} from "./index.js";

const workspaceId = "ws-1";
const disputeId = "disp-1";
const leadId = "lead-1";
const payoutId = "pay-1";

function opened(
  overrides: Partial<DisputeEvent> = {},
  dataOverrides: Partial<Extract<DisputeEvent, { type: "dispute.opened" }>["data"]> = {},
): DisputeEvent {
  return {
    id: "evt-opened-1",
    sequence: 1,
    workspaceId,
    disputeId,
    leadId,
    payoutId,
    source: "test",
    sourceEventId: "src-opened-1",
    occurredAt: "2024-01-01T00:00:00.000Z",
    type: "dispute.opened",
    data: {
      payoutId,
      category: "incorrect",
      expectedAmountMinor: 1000,
      description: "Wrong amount",
      autoApproveAt: "2024-03-16T00:00:00.000Z",
      ...dataOverrides,
    },
    ...overrides,
  } as Extract<DisputeEvent, { type: "dispute.opened" }>;
}

function queried(
  sequence = 2,
  overrides: Partial<DisputeEvent> = {},
  dataOverrides: Partial<Extract<DisputeEvent, { type: "dispute.queried" }>["data"]> = {},
): DisputeEvent {
  return {
    id: "evt-query-1",
    sequence,
    workspaceId,
    disputeId,
    leadId,
    payoutId,
    source: "test",
    sourceEventId: `src-query-${sequence}`,
    occurredAt: "2024-01-02T00:00:00.000Z",
    type: "dispute.queried",
    data: { question: "Need more info", ...dataOverrides },
    ...overrides,
  } as Extract<DisputeEvent, { type: "dispute.queried" }>;
}

function resolved(
  sequence = 3,
  outcome: "upheld" | "dismissed" = "upheld",
  note = "Resolved based on evidence",
  overrides: Partial<DisputeEvent> = {},
  dataOverrides: Partial<Extract<DisputeEvent, { type: "dispute.resolved" }>["data"]> = {},
): DisputeEvent {
  return {
    id: "evt-resolve-1",
    sequence,
    workspaceId,
    disputeId,
    leadId,
    payoutId,
    source: "test",
    sourceEventId: `src-resolve-${sequence}`,
    occurredAt: "2024-01-03T00:00:00.000Z",
    type: "dispute.resolved",
    data: { outcome, note, ...dataOverrides },
    ...overrides,
  } as Extract<DisputeEvent, { type: "dispute.resolved" }>;
}

function makeState(overrides: Partial<DisputeState> = {}): DisputeState {
  return {
    workspaceId,
    disputeId,
    leadId,
    payoutId,
    category: "incorrect",
    expectedAmountMinor: 1000,
    description: "Wrong amount",
    status: "open",
    outcome: null,
    autoApproveAt: "2024-03-16T00:00:00.000Z",
    lastSequence: 1,
    ...overrides,
  };
}

describe("replayDisputeEvents", () => {
  it("replays a full upheld path", () => {
    const state = replayDisputeEvents([opened(), queried(), resolved()], workspaceId, disputeId);
    expect(state).toEqual({
      workspaceId, disputeId, leadId, payoutId,
      category: "incorrect", expectedAmountMinor: 1000, description: "Wrong amount",
      status: "resolved", outcome: "upheld", autoApproveAt: "2024-03-16T00:00:00.000Z", lastSequence: 3,
    });
  });

  it("replays a dismissed path", () => {
    const state = replayDisputeEvents([opened(), resolved(2, "dismissed", "No evidence found")], workspaceId, disputeId);
    expect(state?.status).toBe("resolved");
    expect(state?.outcome).toBe("dismissed");
  });

  it("allows untracked disputes with null expectedAmountMinor", () => {
    const state = replayDisputeEvents(
      [opened({}, { category: "untracked", expectedAmountMinor: null, description: "Not tracked" })],
      workspaceId, disputeId,
    );
    expect(state?.category).toBe("untracked");
    expect(state?.expectedAmountMinor).toBeNull();
    expect(state?.status).toBe("open");
  });

  it("allows declined disputes with null expectedAmountMinor", () => {
    const state = replayDisputeEvents(
      [opened({}, { category: "declined", expectedAmountMinor: null, description: "Declined" })],
      workspaceId, disputeId,
    );
    expect(state?.category).toBe("declined");
    expect(state?.expectedAmountMinor).toBeNull();
  });

  it("requires expectedAmountMinor for incorrect category", () => {
    expect(() =>
      replayDisputeEvents([opened({}, { expectedAmountMinor: undefined as unknown as number })], workspaceId, disputeId),
    ).toThrow();
  });

  it("rejects expectedAmountMinor on non-incorrect categories", () => {
    expect(() =>
      replayDisputeEvents(
        [opened({}, { category: "untracked", expectedAmountMinor: 500, description: "Untracked" })],
        workspaceId, disputeId,
      ),
    ).toThrow();
  });

  it("rejects negative expectedAmountMinor", () => {
    expect(() => replayDisputeEvents([opened({}, { expectedAmountMinor: -1 })], workspaceId, disputeId)).toThrow();
  });

  it("rejects fractional expectedAmountMinor", () => {
    expect(() => replayDisputeEvents([opened({}, { expectedAmountMinor: 1.5 })], workspaceId, disputeId)).toThrow();
  });

  it("rejects an invalid category", () => {
    expect(() =>
      replayDisputeEvents([opened({}, { category: "bogus" as unknown as "untracked", expectedAmountMinor: null })], workspaceId, disputeId),
    ).toThrow();
  });

  it("rejects empty description", () => {
    expect(() => replayDisputeEvents([opened({}, { description: "   " })], workspaceId, disputeId)).toThrow();
  });

  it("rejects empty resolution note", () => {
    expect(() => replayDisputeEvents([opened(), queried(), resolved(3, "upheld", "  ")], workspaceId, disputeId)).toThrow();
  });

  it("rejects an invalid outcome", () => {
    expect(() =>
      replayDisputeEvents([opened(), resolved(2, "bogus" as unknown as "upheld")], workspaceId, disputeId),
    ).toThrow();
  });

  it("rejects autoApproveAt before occurredAt", () => {
    expect(() =>
      replayDisputeEvents([opened({}, { autoApproveAt: "2023-12-31T23:59:59.000Z" })], workspaceId, disputeId),
    ).toThrow();
  });

  it("rejects autoApproveAt that is not a real ISO instant", () => {
    expect(() => replayDisputeEvents([opened({}, { autoApproveAt: "not-a-time" })], workspaceId, disputeId)).toThrow();
  });

  it("rejects a second dispute.opened on the same dispute id", () => {
    const second = opened({ id: "evt-opened-2", sequence: 2, sourceEventId: "src-opened-2" });
    expect(() => replayDisputeEvents([opened(), second], workspaceId, disputeId)).toThrow();
  });

  it("rejects dispute.queried after dispute.resolved", () => {
    const duplicateQuery = queried(4, { id: "evt-query-2", sourceEventId: "src-query-2" });
    expect(() => replayDisputeEvents([opened(), queried(2), resolved(3), duplicateQuery], workspaceId, disputeId)).toThrow();
  });

  it("rejects dispute.resolved after dispute.resolved", () => {
    const secondResolution = resolved(4, "dismissed", "Second resolution", { id: "evt-resolve-2", sourceEventId: "src-resolve-2" });
    expect(() => replayDisputeEvents([opened(), queried(2), resolved(3), secondResolution], workspaceId, disputeId)).toThrow();
  });

  it("rejects a query before an opened event", () => {
    expect(() => replayDisputeEvents([queried(1)], workspaceId, disputeId)).toThrow();
  });

  it("ignores an idempotent retry with the same id and fingerprint", () => {
    const state = replayDisputeEvents([opened(), opened(), queried(2), resolved(3)], workspaceId, disputeId);
    expect(state?.lastSequence).toBe(3);
    expect(state?.status).toBe("resolved");
  });

  it("throws on conflicting duplicate event id", () => {
    const conflicting = opened({}, { description: "Different description" });
    expect(() => replayDisputeEvents([opened(), conflicting], workspaceId, disputeId)).toThrow();
  });

  it("throws on duplicate (source, sourceEventId)", () => {
    const sameSource = opened({ id: "evt-opened-2", sequence: 2, sourceEventId: "src-opened-1" });
    expect(() => replayDisputeEvents([opened(), sameSource], workspaceId, disputeId)).toThrow();
  });

  it("rejects out-of-order sequence", () => {
    const first = opened({ sequence: 2, sourceEventId: "src-opened-2" });
    const second = opened({ sequence: 1, sourceEventId: "src-opened-1", id: "evt-opened-2" });
    expect(() => replayDisputeEvents([first, second], workspaceId, disputeId)).toThrow();
  });

  it("rejects repeated sequence", () => {
    const duplicateSequence = queried(1, { id: "evt-query-1", sourceEventId: "src-query-1" });
    expect(() => replayDisputeEvents([opened(), duplicateSequence], workspaceId, disputeId)).toThrow();
  });

  it("rejects wrong workspaceId", () => {
    expect(() => replayDisputeEvents([opened({ workspaceId: "ws-other" })], workspaceId, disputeId)).toThrow();
  });

  it("rejects wrong disputeId", () => {
    expect(() => replayDisputeEvents([opened({ disputeId: "disp-other" })], workspaceId, disputeId)).toThrow();
  });

  it("rejects event data payoutId that does not match event.payoutId", () => {
    expect(() => replayDisputeEvents([opened({}, { payoutId: "pay-other" })], workspaceId, disputeId)).toThrow();
  });

  it("rejects a later event whose leadId drifts from the dispute's lead", () => {
    const drifted = queried(2, { leadId: "lead-other" });
    expect(() => replayDisputeEvents([opened(), drifted], workspaceId, disputeId)).toThrow();
  });

  it("rejects a later event whose payoutId drifts from the dispute's payout", () => {
    const drifted = queried(2, { payoutId: "pay-other" });
    expect(() => replayDisputeEvents([opened(), drifted], workspaceId, disputeId)).toThrow();
  });
});

describe("disputeAutoApproveAt", () => {
  it("adds days in milliseconds", () => {
    expect(disputeAutoApproveAt("2024-01-01T00:00:00.000Z", 75)).toBe("2024-03-16T00:00:00.000Z");
  });

  it("rejects negative day count", () => {
    expect(() => disputeAutoApproveAt("2024-01-01T00:00:00.000Z", -1)).toThrow();
  });

  it("rejects fractional day count", () => {
    expect(() => disputeAutoApproveAt("2024-01-01T00:00:00.000Z", 1.5)).toThrow();
  });

  it("rejects malformed openedAt", () => {
    expect(() => disputeAutoApproveAt("not-a-time", 75)).toThrow();
  });
});

describe("isDisputeOverdue", () => {
  it("is false for null state", () => {
    expect(isDisputeOverdue(null, "2024-03-16T00:00:00.000Z")).toBe(false);
  });

  it("is false for a resolved state even if now is past autoApproveAt", () => {
    expect(isDisputeOverdue(makeState({ status: "resolved" }), "2024-03-17T00:00:00.000Z")).toBe(false);
  });

  it("is true for open state when now is at or after autoApproveAt", () => {
    expect(isDisputeOverdue(makeState(), "2024-03-16T00:00:00.000Z")).toBe(true);
    expect(isDisputeOverdue(makeState(), "2024-03-17T00:00:00.000Z")).toBe(true);
  });

  it("is false for open state when now is before autoApproveAt", () => {
    expect(isDisputeOverdue(makeState(), "2024-03-15T23:59:59.999Z")).toBe(false);
  });

  it("is true for queried state when now is at or after autoApproveAt", () => {
    expect(isDisputeOverdue(makeState({ status: "queried" }), "2024-03-16T00:00:00.000Z")).toBe(true);
  });
});
