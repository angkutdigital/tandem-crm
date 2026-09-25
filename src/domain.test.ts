import { describe, expect, it } from "vitest";
import {
  assertMoney, calculateCommissionMinor, commissionReleaseAt,
  defaultTandemConfig, defineTandemConfig, eventIdempotencyKey,
  qualifyLead, replayLeadEvents, type TandemEvent,
} from "./index.js";

const paidAt = "2026-01-01T00:00:00.000Z";
const releaseAt = "2026-01-31T00:00:00.000Z";
function fact(sequence: number, type: TandemEvent["type"], data: TandemEvent["data"], occurredAt = paidAt): TandemEvent {
  return {
    id: `event-${sequence}`, sequence, workspaceId: "workspace-1", leadId: "lead-1",
    source: "test", sourceEventId: `source-${sequence}`, occurredAt, type, data,
  } as TandemEvent;
}
function paidLead(): TandemEvent[] {
  return [
    fact(1, "lead.created", { companyName: "Fleet", vehicleCount: 15, qualification: "Automated_Setup", partnerId: "partner-1" }),
    fact(2, "lead.assigned", { agentId: "agent-1", territoryId: "territory-1" }),
    fact(3, "conversion.confirmed", {}),
    fact(4, "payment.confirmed", { amountMinor: 10_001, currency: "MYR" }),
    fact(5, "commission.held", { payoutId: "payout-1", partnerId: "partner-1", amountMinor: 1_000, currency: "MYR", releaseAt }),
  ];
}
const replay = (events: TandemEvent[]) => replayLeadEvents(events, "workspace-1", "lead-1");

describe("Tandem qualification and idempotency", () => {
  it("honours the configured fleet threshold and snapshots qualification", () => {
    expect(qualifyLead({ vehicleCount: 15 }, defaultTandemConfig)).toEqual({
      status: "Automated_Setup", requiresHumanReview: false, shouldStartCheckout: true,
    });
    expect(qualifyLead({ vehicleCount: 16 }, defaultTandemConfig).status).toBe("Manual_Review");
    const config = defineTandemConfig({ qualification: { automatedSetupMaxVehicleCount: 3 }, commission: { holdDays: 14 } });
    expect(qualifyLead({ vehicleCount: 4 }, config).status).toBe("Manual_Review");
    expect(() => qualifyLead({ vehicleCount: -1 }, config)).toThrow();
    expect(() => qualifyLead({ vehicleCount: 1.5 }, config)).toThrow();
    expect(() => defineTandemConfig({ qualification: { automatedSetupMaxVehicleCount: 1 }, commission: { holdDays: 1.5 } })).toThrow();
  });
  it("normalizes source, retains event ID case, and avoids separator collisions", () => {
    expect(eventIdempotencyKey(" Stripe ", " evt_123 ")).toBe('["stripe","evt_123"]');
    expect(eventIdempotencyKey("a:b", "c")).not.toBe(eventIdempotencyKey("a", "b:c"));
    expect(() => eventIdempotencyKey("", "evt")).toThrow();
  });
});

describe("Tandem deterministic replay", () => {
  it("replays by database sequence and ignores an exact retry", () => {
    const events = paidLead();
    const result = replay([events[4], events[0], events[2], events[1], events[3], { ...events[3] }]);
    expect(result).toMatchObject({
      status: "Commission_Hold", agentId: "agent-1", territoryId: "territory-1",
      commission: { status: "held", amountMinor: 1_000 }, lastSequence: 5,
    });
  });
  it("rejects conflicting IDs, source IDs, sequences, and cross-workspace facts", () => {
    const events = paidLead();
    expect(() => replay([events[0], { ...events[0], data: { ...events[0].data, companyName: "Other" } } as TandemEvent])).toThrow("conflicting duplicate event id");
    expect(() => replay([events[0], { ...events[1], sourceEventId: events[0].sourceEventId }])).toThrow("conflicting duplicate source event id");
    expect(() => replay([events[0], { ...events[1], sequence: 1 }])).toThrow("duplicate or out-of-order event sequence");
    expect(() => replay([{ ...events[0], workspaceId: "workspace-2" }])).toThrow("another lead or workspace");
  });
  it("rejects invalid transitions and cross-currency commission holds", () => {
    expect(() => replay([fact(1, "payment.confirmed", { amountMinor: 100, currency: "MYR" })])).toThrow("invalid transition");
    expect(() => replay([...paidLead(), fact(6, "commission.paid", { payoutId: "payout-1", payoutReference: "manual-1" })])).toThrow("invalid transition");
    const events = paidLead();
    events[4] = fact(5, "commission.held", { payoutId: "payout-1", partnerId: "partner-1", amountMinor: 1_000, currency: "USD", releaseAt });
    expect(() => replay(events)).toThrow("invalid commission hold");
  });
  it("rejects unknown persisted event types during replay", () => {
    const unknown = { ...paidLead()[0], type: "payment.partially_refunded" } as unknown as TandemEvent;
    expect(() => replay([unknown])).toThrow("unsupported event type: payment.partially_refunded");
  });
});

describe("Tandem escrow and money", () => {
  it("releases at the exact 30-day instant, including later on day 31", () => {
    expect(commissionReleaseAt(paidAt, 30)).toBe(releaseAt);
    expect(() => replay([...paidLead(), fact(6, "commission.eligible", { payoutId: "payout-1" }, "2026-01-30T00:00:00.000Z")])).toThrow("invalid transition");
    expect(replay([...paidLead(), fact(6, "commission.eligible", { payoutId: "payout-1" }, releaseAt)])?.commission?.status).toBe("eligible");
    expect(replay([...paidLead(), fact(6, "commission.eligible", { payoutId: "payout-1" }, "2026-02-01T00:00:00.000Z")])?.status).toBe("Commission_Eligible");
  });
  it("voids an unpaid commission on refund and blocks later eligibility", () => {
    const refunded = [...paidLead(), fact(6, "payment.refunded", { reason: "full refund" })];
    expect(replay(refunded)).toMatchObject({ status: "Refunded", commission: { status: "voided" } });
    expect(() => replay([...refunded, fact(7, "commission.eligible", { payoutId: "payout-1" }, releaseAt)])).toThrow("invalid transition");
    const approved = [...paidLead(), fact(6, "commission.eligible", { payoutId: "payout-1" }, releaseAt), fact(7, "commission.approved", { payoutId: "payout-1" }, releaseAt)];
    expect(replay([...approved, fact(8, "commission.voided", { payoutId: "payout-1", reason: "dispute" }, releaseAt)])?.commission?.status).toBe("voided");
    const settled = [...approved, fact(8, "commission.paid", { payoutId: "payout-1", payoutReference: "manual-1" }, releaseAt)];
    expect(() => replay([...settled, fact(9, "payment.refunded", { reason: "late refund" }, releaseAt)])).toThrow("invalid transition");
  });
  it("rounds integer basis points half-up and rejects unsafe or negative money", () => {
    expect(calculateCommissionMinor(99, 50)).toBe(0);
    expect(calculateCommissionMinor(100, 50)).toBe(1);
    expect(calculateCommissionMinor(101, 50)).toBe(1);
    expect(calculateCommissionMinor(10_001, 10_000)).toBe(10_001);
    expect(() => calculateCommissionMinor(100, 10_001)).toThrow();
    expect(() => assertMoney(-1, "MYR")).toThrow();
    expect(() => assertMoney(1.5, "MYR")).toThrow();
    expect(() => assertMoney(Number.MAX_SAFE_INTEGER + 1, "MYR")).toThrow();
    expect(() => assertMoney(100, "myr")).toThrow();
    expect(() => assertMoney(100, "US")).toThrow();
  });
});
