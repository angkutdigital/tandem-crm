import { describe, expect, it } from "vitest";
import { replayLeadEvents, type LeadState, type TandemEvent } from "./domain.js";
import {
  customerAgeMonths,
  partnerBalance,
  planPartnerDeactivation,
  planPaymentCommission,
  rateForCustomerAge,
} from "./commissions.js";
import { defineTandemConfig, type TandemConfig } from "./tandem.config.js";

const W = "w", L = "lead-1";
let seq = 0;
function ev(type: TandemEvent["type"], data: unknown, at = "2026-01-01T00:00:00.000Z"): TandemEvent {
  seq += 1;
  return { id: `e${seq}`, sequence: seq, workspaceId: W, leadId: L, source: "test", sourceEventId: `s${seq}`, occurredAt: at, type, data } as TandemEvent;
}
const replay = (events: TandemEvent[]) => replayLeadEvents(events, W, L) as LeadState;
function wonLead(): TandemEvent[] {
  seq = 0;
  return [
    ev("lead.created", { companyName: "Acme", qualificationMetric: 3, qualification: "Automated_Setup", partnerId: "partner-1" }),
    ev("conversion.confirmed", {}),
  ];
}
const pay = (paymentId: string, amountMinor: number, at: string) => ev("payment.confirmed", { paymentId, amountMinor, currency: "MYR" }, at);
const hold = (payoutId: string, paymentId: string, amountMinor: number, at: string, releaseAt: string) =>
  ev("commission.held", { payoutId, paymentId, partnerId: "partner-1", amountMinor, currency: "MYR", releaseAt }, at);

describe("many payments, one line each", () => {
  it("records a line per payment and derives the lead status from all lines", () => {
    const events = [
      ...wonLead(),
      pay("inv_1", 10_000, "2026-01-01T00:00:00.000Z"), hold("p1", "inv_1", 2_500, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z"),
      pay("inv_2", 10_000, "2026-02-01T00:00:00.000Z"), hold("p2", "inv_2", 2_500, "2026-02-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z"),
    ];
    let s = replay(events);
    expect(s.payments.map((p) => p.paymentId)).toEqual(["inv_1", "inv_2"]);
    expect(s.commissions.map((l) => [l.payoutId, l.paymentId, l.status])).toEqual([["p1", "inv_1", "held"], ["p2", "inv_2", "held"]]);
    expect(s.status).toBe("Commission_Hold");
    expect(s.customerSince).toBe("2026-01-01T00:00:00.000Z");
    expect(s.commission?.payoutId).toBe("p2"); // 0.1 alias: most recent line
    events.push(ev("commission.eligible", { payoutId: "p1" }, "2026-01-31T00:00:00.000Z"));
    s = replay(events);
    expect(s.status).toBe("Commission_Eligible"); // work to act on comes first
    events.push(ev("commission.approved", { payoutId: "p1" }), ev("commission.paid", { payoutId: "p1", payoutReference: "tr_1" }));
    s = replay(events);
    expect(s.status).toBe("Commission_Hold");
    expect(s.commissions[0].status).toBe("paid");
  });
  it("rejects a repeated payment id, a second line for one payment, a reused payout id and mixed currencies", () => {
    const base = [...wonLead(), pay("inv_1", 10_000, "2026-01-01T00:00:00.000Z")];
    expect(() => replay([...base, pay("inv_1", 10_000, "2026-01-02T00:00:00.000Z")])).toThrow("payment already recorded");
    const held = [...base, hold("p1", "inv_1", 100, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z")];
    expect(() => replay([...held, hold("p9", "inv_1", 100, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z")])).toThrow("invalid transition");
    const two = [...held, pay("inv_2", 10_000, "2026-02-01T00:00:00.000Z")];
    expect(() => replay([...two, hold("p1", "inv_2", 100, "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z")])).toThrow("payoutId is already used");
    expect(() => replay([...base, ev("payment.confirmed", { paymentId: "inv_x", amountMinor: 5, currency: "USD" })])).toThrow("same currency");
    expect(() => replay([...two, ev("commission.held", { payoutId: "p3", partnerId: "partner-1", amountMinor: 1, currency: "MYR", releaseAt: "2026-03-01T00:00:00.000Z" })])).toThrow("paymentId is required");
    expect(() => replay([...base, hold("p1", "inv_1", 10_001, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z")])).toThrow("invalid commission hold");
  });
});

describe("partial refunds", () => {
  const start = () => [...wonLead(), pay("inv_1", 10_000, "2026-01-01T00:00:00.000Z"), hold("p1", "inv_1", 2_501, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z")];
  it("reduces an unpaid line in proportion, rounding half up, and voids it exactly on the last refund", () => {
    const events = start();
    events.push(ev("payment.refunded", { paymentId: "inv_1", amountMinor: 3_333, reason: "pro rata" }));
    let s = replay(events);
    // 2501 * 3333 / 10000 = 833.58 -> 834
    expect(s.commissions[0]).toMatchObject({ amountMinor: 1_667, status: "held" });
    expect(s.payments[0]).toMatchObject({ refundedMinor: 3_333, refunded: false });
    expect(s.status).toBe("Commission_Hold");
    events.push(ev("payment.refunded", { paymentId: "inv_1", amountMinor: 6_667, reason: "rest" }));
    s = replay(events);
    expect(s.commissions[0].status).toBe("voided");
    expect(s.status).toBe("Refunded");
    expect(() => replay([...events, ev("payment.refunded", { paymentId: "inv_1", amountMinor: 1, reason: "again" })])).toThrow("invalid transition");
  });
  it("turns a refund after payout into a running clawback that is exact when the whole payment is refunded", () => {
    const events = [...start(),
      ev("commission.eligible", { payoutId: "p1" }, "2026-01-31T00:00:00.000Z"),
      ev("commission.approved", { payoutId: "p1" }), ev("commission.paid", { payoutId: "p1", payoutReference: "tr_1" }),
      ev("payment.refunded", { paymentId: "inv_1", amountMinor: 3_333, reason: "pro rata" }),
    ];
    let s = replay(events);
    expect(s.commissions[0]).toMatchObject({ status: "paid", amountMinor: 2_501, clawback: { amountMinor: 834, recoveredMinor: 0 } });
    events.push(ev("payment.refunded", { paymentId: "inv_1", amountMinor: 6_667, reason: "rest" }));
    s = replay(events);
    expect(s.commissions[0].clawback?.amountMinor).toBe(2_501);
    events.push(ev("commission.clawback_recovered", { payoutId: "p1", amountMinor: 2_000, reference: "deducted from March" }));
    s = replay(events);
    expect(s.commissions[0].clawback).toMatchObject({ amountMinor: 2_501, recoveredMinor: 2_000 });
    expect(partnerBalance([s], "partner-1").MYR.clawbackOwedMinor).toBe(501);
    expect(() => replay([...events, ev("commission.clawback_recovered", { payoutId: "p1", amountMinor: 502, reference: "x" })])).toThrow("cannot exceed");
  });
  it("needs a payment id to refund a lead with several payments", () => {
    const events = [...start(), pay("inv_2", 10_000, "2026-02-01T00:00:00.000Z")];
    expect(() => replay([...events, ev("payment.refunded", { reason: "which one?" })])).toThrow("paymentId is required");
  });
});

describe("customer age and rates", () => {
  it("counts whole calendar months in UTC with the anniversary instant in the new month", () => {
    expect(customerAgeMonths("2026-01-15T10:00:00.000Z", "2027-01-15T09:59:59.999Z")).toBe(11);
    expect(customerAgeMonths("2026-01-15T10:00:00.000Z", "2027-01-15T10:00:00.000Z")).toBe(12);
    expect(customerAgeMonths("2026-01-31T00:00:00.000Z", "2026-02-28T00:00:00.000Z")).toBe(1);
    expect(customerAgeMonths("2026-01-31T00:00:00.000Z", "2026-02-27T23:59:59.000Z")).toBe(0);
    expect(customerAgeMonths("2028-02-29T00:00:00.000Z", "2029-02-28T00:00:00.000Z")).toBe(12);
    expect(customerAgeMonths("2026-05-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z")).toBe(0);
  });
  it("picks the last tier at or below the age and validates the schedule", () => {
    const schedule = [{ fromMonth: 0, basisPoints: 2500 }, { fromMonth: 12, basisPoints: 2000 }];
    expect(rateForCustomerAge(schedule, 11).basisPoints).toBe(2500);
    expect(rateForCustomerAge(schedule, 12).basisPoints).toBe(2000);
    expect(() => rateForCustomerAge([{ fromMonth: 1, basisPoints: 1 }], 3)).toThrow("start at fromMonth 0");
    expect(() => defineTandemConfig({ qualification: { automatedSetupMaxQualificationMetric: 1 }, commission: { holdDays: 1, rateSchedule: [{ fromMonth: 0, basisPoints: 10_001 }] } })).toThrow("basisPoints");
  });
});

describe("planning a payment's commission", () => {
  const config = (futurePayments: "continue" | "house" | "forfeit"): TandemConfig => defineTandemConfig({
    qualification: { automatedSetupMaxQualificationMetric: 15 },
    commission: { holdDays: 30, rateSchedule: [{ fromMonth: 0, basisPoints: 2500 }, { fromMonth: 12, basisPoints: 2000 }] },
    partners: { houseAccountId: "house", onDeactivation: { futurePayments, heldLines: "house" } },
  });
  const firstPaid = () => replay([...wonLead(), pay("inv_1", 9_990, "2026-01-15T10:00:00.000Z")]);
  const payment = (at: string) => ({ paymentId: "inv_2", amountMinor: 9_990, currency: "MYR", confirmedAt: at });
  it("uses the year-one rate before the anniversary and the later rate on it, saving every input", () => {
    const lead = firstPaid();
    const before = planPaymentCommission({ lead, payment: payment("2027-01-15T09:59:59.000Z"), partner: { id: "partner-1", active: true }, config: config("continue"), payoutId: "p2" });
    expect(before).toMatchObject({ kind: "hold", data: { amountMinor: 2_498, basisPoints: 2500, customerAgeMonths: 11, beneficiary: "partner", partnerId: "partner-1", releaseAt: "2027-02-14T09:59:59.000Z" } });
    const on = planPaymentCommission({ lead, payment: payment("2027-01-15T10:00:00.000Z"), partner: { id: "partner-1", active: true }, config: config("continue"), payoutId: "p2" });
    expect(on).toMatchObject({ kind: "hold", data: { amountMinor: 1_998, basisPoints: 2000, customerAgeMonths: 12 } });
  });
  it("follows the deactivation policy for an inactive partner", () => {
    const lead = firstPaid();
    const inactive = { id: "partner-1", active: false };
    expect(planPaymentCommission({ lead, payment: payment("2026-02-15T10:00:00.000Z"), partner: inactive, config: config("continue"), payoutId: "p2" }))
      .toMatchObject({ kind: "hold", data: { partnerId: "partner-1", beneficiary: "partner", beneficiaryReason: expect.stringContaining("keeps paying") } });
    expect(planPaymentCommission({ lead, payment: payment("2026-02-15T10:00:00.000Z"), partner: inactive, config: config("house"), payoutId: "p2" }))
      .toMatchObject({ kind: "hold", data: { partnerId: "house", beneficiary: "house", originalPartnerId: "partner-1" } });
    expect(planPaymentCommission({ lead, payment: payment("2026-02-15T10:00:00.000Z"), partner: inactive, config: config("forfeit"), payoutId: "p2" }))
      .toMatchObject({ kind: "forfeit", data: { paymentId: "inv_2", partnerId: "partner-1" } });
    expect(() => planPaymentCommission({ lead, payment: payment("2026-02-15T10:00:00.000Z"), partner: { id: "someone-else", active: true }, config: config("house"), payoutId: "p2" })).toThrow("different partner");
    expect(() => planPaymentCommission({ lead, payment: payment("2026-02-15T10:00:00.000Z"), partner: null, config: config("house"), payoutId: "p2" })).toThrow("status is required");
  });
  it("handles an annual prepay as one line with its own hold", () => {
    seq = 0;
    const lead = replay([ev("lead.created", { companyName: "Annual", qualificationMetric: 1, qualification: "Automated_Setup", partnerId: "partner-1" }), ev("conversion.confirmed", {})]);
    const plan = planPaymentCommission({ lead, payment: { paymentId: "inv_year", amountMinor: 118_800, currency: "MYR", confirmedAt: "2026-03-01T00:00:00.000Z" }, partner: { id: "partner-1", active: true }, config: config("continue"), payoutId: "py", holdDays: 60 });
    expect(plan).toMatchObject({ kind: "hold", data: { amountMinor: 29_700, customerAgeMonths: 0, releaseAt: "2026-04-30T00:00:00.000Z" } });
  });
  it("records a visible skip for a lead without a partner or a commission that rounds to zero", () => {
    seq = 0;
    const noPartner = replay([ev("lead.created", { companyName: "Direct", qualificationMetric: 1, qualification: "Automated_Setup" }), ev("conversion.confirmed", {})]);
    const noPartnerPlan = planPaymentCommission({ lead: noPartner, payment: payment("2026-02-01T00:00:00.000Z"), partner: null, config: config("house"), payoutId: "p" });
    expect(noPartnerPlan).toMatchObject({ kind: "skip", type: "commission.skipped", data: { paymentId: "inv_2", reason: "the lead has no partner" } });
    const zeroPlan = planPaymentCommission({ lead: firstPaid(), payment: { ...payment("2026-02-01T00:00:00.000Z"), amountMinor: 1 }, partner: { id: "partner-1", active: true }, config: config("house"), payoutId: "p", basisPoints: 1 });
    expect(zeroPlan).toMatchObject({ kind: "skip", type: "commission.skipped", data: { reason: "the commission rounds to zero" } });
  });
  it("produces events the reducer accepts, and a forfeited payment can never get a line", () => {
    const events = [...wonLead(), pay("inv_1", 9_990, "2026-01-15T10:00:00.000Z")];
    const lead = replay(events);
    const plan = planPaymentCommission({ lead, payment: payment("2026-02-15T10:00:00.000Z"), partner: { id: "partner-1", active: false }, config: config("forfeit"), payoutId: "p2" });
    if (plan.kind !== "forfeit") throw new Error("expected forfeit");
    events.push(pay("inv_2", 9_990, "2026-02-15T10:00:00.000Z"), ev(plan.type, plan.data, "2026-02-15T10:00:00.000Z"));
    const s = replay(events);
    expect(s.payments[1].forfeited).toMatchObject({ partnerId: "partner-1" });
    expect(() => replay([...events, hold("p2", "inv_2", 1, "2026-02-15T10:00:00.000Z", "2026-03-17T10:00:00.000Z")])).toThrow("invalid transition");
  });
});

describe("partner deactivation", () => {
  function leadWithLines() {
    const events = [
      ...wonLead(),
      pay("inv_1", 10_000, "2026-01-01T00:00:00.000Z"), hold("p1", "inv_1", 2_500, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z"),
      ev("commission.eligible", { payoutId: "p1" }, "2026-01-31T00:00:00.000Z"), ev("commission.approved", { payoutId: "p1" }), ev("commission.paid", { payoutId: "p1", payoutReference: "tr_1" }),
      pay("inv_2", 10_000, "2026-02-01T00:00:00.000Z"), hold("p2", "inv_2", 2_500, "2026-02-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z"),
      ev("commission.eligible", { payoutId: "p2" }, "2026-03-03T00:00:00.000Z"), ev("commission.approved", { payoutId: "p2" }),
      pay("inv_3", 10_000, "2026-03-01T00:00:00.000Z"), hold("p3", "inv_3", 2_500, "2026-03-01T00:00:00.000Z", "2026-03-31T00:00:00.000Z"),
    ];
    return events;
  }
  const cfg = (heldLines: "keep" | "house" | "void"): TandemConfig => ({
    qualification: { automatedSetupMaxQualificationMetric: 15 }, commission: { holdDays: 30 },
    partners: { houseAccountId: "house", onDeactivation: { futurePayments: "house", heldLines } },
  });
  it("moves unpaid lines to the house, sends approved ones back to eligible, and never touches paid lines", () => {
    const events = leadWithLines();
    const plans = planPartnerDeactivation({ leads: [replay(events)], partnerId: "partner-1", config: cfg("house"), reason: "left the program" });
    expect(plans).toHaveLength(1);
    expect(plans[0].events.map((e) => [e.type, e.data.payoutId])).toEqual([["commission.transferred", "p2"], ["commission.transferred", "p3"]]);
    for (const e of plans[0].events) events.push(ev(e.type, e.data));
    const s = replay(events);
    expect(s.commissions.map((l) => [l.payoutId, l.partnerId, l.beneficiary, l.status])).toEqual([
      ["p1", "partner-1", "partner", "paid"], ["p2", "house", "house", "eligible"], ["p3", "house", "house", "held"],
    ]);
    expect(s.commissions[1].originalPartnerId).toBe("partner-1");
    // A second sweep finds nothing left to move; a house line cannot be transferred again.
    expect(planPartnerDeactivation({ leads: [s], partnerId: "partner-1", config: cfg("house") })).toEqual([]);
    expect(() => replay([...events, ev("commission.transferred", { payoutId: "p2", toPartnerId: "other", reason: "x" })])).toThrow("invalid transition");
    expect(() => replay([...events, ev("commission.transferred", { payoutId: "p1", toPartnerId: "house", reason: "x" })])).toThrow("invalid transition");
  });
  it("voids unpaid lines under the void policy and does nothing under keep", () => {
    const lead = replay(leadWithLines());
    expect(planPartnerDeactivation({ leads: [lead], partnerId: "partner-1", config: cfg("void") })[0].events.map((e) => e.type)).toEqual(["commission.voided", "commission.voided"]);
    expect(planPartnerDeactivation({ leads: [lead], partnerId: "partner-1", config: cfg("keep") })).toEqual([]);
    expect(() => planPartnerDeactivation({ leads: [lead], partnerId: "house", config: cfg("void") })).toThrow("house account");
  });
  it("totals a partner's balance per currency", () => {
    const lead = replay(leadWithLines());
    expect(partnerBalance([lead], "partner-1")).toEqual({ MYR: { heldMinor: 2_500, eligibleMinor: 0, approvedMinor: 2_500, paidMinor: 2_500, clawbackOwedMinor: 0 } });
  });
});

describe("attaching a partner to a lead", () => {
  const direct = () => {
    seq = 0;
    return [ev("lead.created", { companyName: "Direct", qualificationMetric: 1, qualification: "Automated_Setup" }), ev("conversion.confirmed", {})];
  };
  const attribute = (partnerId: string) => ev("lead.partner_attributed", { partnerId, reason: "referral confirmed" });

  it("attaches a partner once, and the next payment earns a line", () => {
    const events = [...direct(), pay("inv_1", 10_000, "2026-01-01T00:00:00.000Z"), ev("commission.skipped", { paymentId: "inv_1", reason: "the lead has no partner" }), attribute("partner-1")];
    const s = replay(events);
    expect(s.partnerId).toBe("partner-1");
    expect(s.payments[0].skipped).toEqual({ reason: "the lead has no partner" });
    expect(() => replay([...events, hold("p1", "inv_1", 100, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z")])).toThrow("invalid transition");
    const config = defineTandemConfig({ qualification: { automatedSetupMaxQualificationMetric: 15 }, commission: { holdDays: 30, rateSchedule: [{ fromMonth: 0, basisPoints: 2_500 }] } });
    const plan = planPaymentCommission({ lead: s, payment: { paymentId: "inv_2", amountMinor: 10_000, currency: "MYR", confirmedAt: "2026-02-01T00:00:00.000Z" }, partner: { id: "partner-1", active: true }, config, payoutId: "p2" });
    expect(plan).toMatchObject({ kind: "hold", data: { partnerId: "partner-1", beneficiary: "partner" } });
    expect(() => replay([...events, attribute("partner-1")])).toThrow("invalid transition");
  });

  it("refuses a lead that already has a partner, a blank partner or reason, and a partner other than the one on an existing line", () => {
    expect(() => replay([...wonLead(), attribute("partner-2")])).toThrow("invalid transition");
    expect(() => replay([...direct(), ev("lead.partner_attributed", { partnerId: " ", reason: "x" })])).toThrow("partnerId and reason are required");
    expect(() => replay([...direct(), ev("lead.partner_attributed", { partnerId: "partner-1", reason: "" })])).toThrow("partnerId and reason are required");
    // A 0.1 lead: the partner lives on the commission, not on lead.created.
    const legacy = [...direct(), ev("payment.confirmed", { amountMinor: 10_000, currency: "MYR" }), ev("commission.held", { payoutId: "p1", partnerId: "partner-1", amountMinor: 1_000, currency: "MYR", releaseAt: "2026-01-31T00:00:00.000Z" })];
    expect(() => replay([...legacy, attribute("partner-2")])).toThrow("invalid transition");
    expect(replay([...legacy, attribute("partner-1")]).partnerId).toBe("partner-1");
  });
});
