#!/usr/bin/env node
// End-to-end test of tandem-camp's money-moving server actions against a real
// Postgres. It drives Camp's compiled actions (approveCommission,
// payCommission, markLeadWon, logTrailVisit, ...) as an owner and as an agent,
// with a recording fake payout adapter, and includes real concurrency (two
// simultaneous pay attempts, two simultaneous mark-won calls).
//
// Why it exists: an independent pre-release audit found that payCommission
// trusted browser-supplied amounts, could pay twice, and that concurrent
// appends could corrupt a lead's history. Typecheck and RLS checks cannot see
// any of that, because it lives in application logic. This is the regression
// test for it.
//
// Run: npm run build && npm run build --prefix packages/camp &&
//      DATABASE_URL=postgres://... node scripts/e2e-money-actions.mjs
import { randomUUID } from "node:crypto";
import * as nodeModule from "node:module";

// Camp's actions import next/cache, which only works inside a Next.js request.
// Swap it for a no-op before importing them.
const stub = new URL("./e2e/next-cache-stub.mjs", import.meta.url).href;
if (nodeModule.registerHooks) {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "next/cache") return { url: stub, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
} else {
  nodeModule.register("./e2e/hooks.mjs", import.meta.url);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const dist = (p) => new URL(`../${p}`, import.meta.url).href;
const { createTandemPool, applyTandemMigrations } = await import(dist("dist/db/index.js"));
const { replayLeadEvents } = await import(dist("dist/index.js"));
const { seedSampleWorkspace } = await import(dist("bin/lib/sampleData.mjs"));
const { mountTandemCamp } = await import(dist("packages/camp/dist/config.js"));
const actions = await import(dist("packages/camp/dist/actions.js"));

const pool = createTandemPool(databaseUrl);
await applyTandemMigrations(pool);
const { rows: [{ role: connectionRole }] } = await pool.query("select current_user as role");
await pool.query(`grant authenticated to "${connectionRole}"`);
const { workspaceId } = await seedSampleWorkspace(pool);

let currentUser = null;
let adapterCalls = [];
let adapterDelayMs = 0;
let adapterShouldFail = false;

const memberRow = (r) => r && ({ id: r.id, workspaceId: r.workspace_id, userId: r.user_id, role: r.role, agentId: r.agent_id });
mountTandemCamp({
  pool, workspaceId,
  authAdapter: {
    getCurrentUserId: async () => currentUser,
    getMember: async (w, u) => memberRow((await pool.query("select * from tandem.members where workspace_id=$1 and user_id=$2", [w, u])).rows[0]),
    getAnyMember: async (u) => memberRow((await pool.query("select * from tandem.members where user_id=$1 limit 1", [u])).rows[0]),
  },
  payoutAdapter: {
    executePayout: async (p) => {
      adapterCalls.push(p);
      if (adapterDelayMs) await new Promise((r) => setTimeout(r, adapterDelayMs));
      if (adapterShouldFail) throw new Error("simulated transfer failure");
      return { payoutReference: `ref-${p.payoutId}` };
    },
  },
});

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? "ok" : "NOT OK"} - ${name}`); if (!ok) failures++; };
const rejects = async (fn, pattern) => { try { await fn(); return false; } catch (e) { return pattern ? pattern.test(String(e.message)) : true; } };

const owner = (await pool.query("select user_id from tandem.members where workspace_id=$1 and role='owner'", [workspaceId])).rows[0].user_id;
const agents = (await pool.query("select user_id, agent_id from tandem.members where workspace_id=$1 and role='agent' order by user_id", [workspaceId])).rows;
const agentUser = agents[0].user_id, agentId = agents[0].agent_id;
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString();

async function insertLead({ name, events, assigneeId }) {
  const leadId = randomUUID();
  let seq = 1; const evs = [];
  for (const [i, [type, data, at]] of events.entries()) {
    const e = { id: randomUUID(), sequence: seq++, workspaceId, leadId, source: "harness", sourceEventId: `h-${leadId}-${i}`, occurredAt: at, type, data };
    evs.push(e);
    await pool.query(`insert into tandem.events (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at) values ($1,$2,'lead',$3,$3,$4,$5,$6,$7,$8)`,
      [e.id, workspaceId, leadId, e.source, e.sourceEventId, type, JSON.stringify(data), at]);
  }
  const s = replayLeadEvents(evs, workspaceId, leadId);
  await pool.query(`insert into tandem.leads (id, workspace_id, company_name, qualification_metric, pipeline_status, sales_stage, assignee_id, last_event_sequence) values ($1,$2,$3,5,$4,$5,$6,$7)`,
    [leadId, workspaceId, name, s.status, s.salesStage, assigneeId, s.lastSequence]);
  let payoutId = null;
  if (s.commission) {
    payoutId = s.commission.payoutId;
    await pool.query(`insert into tandem.payouts (id, workspace_id, lead_id, partner_id, amount_minor, currency, hold_days, payment_confirmed_at, release_at, status, last_event_id) values ($1,$2,$3,$4,$5,$6,30,$7,$8,$9,$10)`,
      [payoutId, workspaceId, leadId, s.commission.partnerId, s.commission.amountMinor, s.commission.currency, s.payment.confirmedAt, s.commission.releaseAt, s.commission.status, evs[evs.length - 1].id]);
  }
  return { leadId, payoutId };
}
const eligibleLead = (name) => { const pid = randomUUID(); return insertLead({ name, assigneeId: agentId, events: [
  ["lead.created", { companyName: name, qualificationMetric: 5, qualification: "Manual_Review" }, iso(-40)],
  ["lead.assigned", { agentId, territoryId: null }, iso(-39)],
  ["conversion.confirmed", {}, iso(-35)],
  ["payment.confirmed", { amountMinor: 500000, currency: "USD" }, iso(-30)],
  ["commission.held", { payoutId: pid, partnerId: "real-partner", amountMinor: 50000, currency: "USD", releaseAt: iso(-10) }, iso(-30)],
  ["commission.eligible", { payoutId: pid }, iso(-9)],
] }); };
const newLead = (name) => insertLead({ name, assigneeId: agentId, events: [["lead.created", { companyName: name, qualificationMetric: 5, qualification: "Manual_Review" }, iso(-1)]] });
const status = async (payoutId) => (await pool.query("select status, amount_minor from tandem.payouts where id=$1", [payoutId])).rows[0];
const eventCount = async (leadId, type) => Number((await pool.query("select count(*) from tandem.events where lead_id=$1 and event_type=$2", [leadId, type])).rows[0].count);

// 1. An agent cannot approve or pay their own commission
{
  const { leadId, payoutId } = await eligibleLead("Agent Attack Co");
  currentUser = agentUser; adapterCalls = [];
  check("agent cannot approve their own commission", await rejects(() => actions.approveCommission(leadId, payoutId), /owner or admin/));
  check("agent cannot pay a commission (and no transfer was attempted)", await rejects(() => actions.payCommission(leadId, payoutId), /owner or admin/) && adapterCalls.length === 0);
  check("agent cannot execute a dispute outcome", await rejects(() => actions.executeDisputeOutcome(randomUUID(), "adjust", 100, "x"), /owner or admin/));
  check("agent cannot resolve a dispute", await rejects(() => actions.resolveDispute(randomUUID(), "upheld", "note"), /owner or admin/));
  check("the payout is untouched and no commission.approved event exists", (await status(payoutId)).status === "eligible" && (await eventCount(leadId, "commission.approved")) === 0);
}

// 2. Owner paying rules: state gate, ownership gate, DB-derived values, failure + retry
{
  const { leadId, payoutId } = await eligibleLead("Owner Flow Co");
  currentUser = owner; adapterCalls = [];
  check("cannot pay a commission that is only eligible (not approved)", await rejects(() => actions.payCommission(leadId, payoutId), /only an approved commission/) && adapterCalls.length === 0);
  await actions.approveCommission(leadId, payoutId);
  check("owner can approve; projection and log agree", (await status(payoutId)).status === "approved" && (await eventCount(leadId, "commission.approved")) === 1);
  check("cannot pay a payout id that does not belong to this lead", await rejects(() => actions.payCommission(leadId, randomUUID()), /does not belong/) && adapterCalls.length === 0);
  adapterShouldFail = true;
  check("a failed transfer throws", await rejects(() => actions.payCommission(leadId, payoutId), /simulated transfer failure/));
  check("a failed transfer leaves the payout approved with no paid event", (await status(payoutId)).status === "approved" && (await eventCount(leadId, "commission.paid")) === 0);
  adapterShouldFail = false; adapterCalls = [];
  await actions.payCommission(leadId, payoutId);
  const call = adapterCalls[0];
  check("the transfer used the partner, amount and currency from the event log", adapterCalls.length === 1 && call.partnerId === "real-partner" && call.amountMinor === 50000 && call.currency === "USD");
  check("after a successful transfer the payout is paid", (await status(payoutId)).status === "paid" && (await eventCount(leadId, "commission.paid")) === 1);
  check("paying again is rejected and sends no second transfer", await rejects(() => actions.payCommission(leadId, payoutId), /only an approved commission/) && adapterCalls.length === 1);
}

// 3. Two simultaneous pay attempts must produce exactly one transfer
{
  const { leadId, payoutId } = await eligibleLead("Double Click Co");
  currentUser = owner;
  await actions.approveCommission(leadId, payoutId);
  adapterCalls = []; adapterDelayMs = 400;
  const results = await Promise.allSettled([actions.payCommission(leadId, payoutId), actions.payCommission(leadId, payoutId)]);
  adapterDelayMs = 0;
  check("two simultaneous pay attempts send exactly one transfer", adapterCalls.length === 1);
  check("exactly one attempt succeeds and one is rejected", results.filter((r) => r.status === "fulfilled").length === 1 && results.filter((r) => r.status === "rejected").length === 1);
  check("the event log has exactly one commission.paid", (await eventCount(leadId, "commission.paid")) === 1);
}

// 4. Concurrent kanban drops, real sequence numbers, agents can still act on their own lead
{
  const { leadId } = await newLead("Race Co");
  currentUser = owner;
  const results = await Promise.allSettled([actions.markLeadWon(leadId), actions.markLeadWon(leadId)]);
  check("two simultaneous mark-won calls write exactly one conversion.confirmed", (await eventCount(leadId, "conversion.confirmed")) === 1 && results.filter((r) => r.status === "fulfilled").length === 1);
  const rows = (await pool.query("select id, sequence, event_type, payload, occurred_at, source, source_event_id from tandem.events where lead_id=$1 order by sequence", [leadId])).rows;
  let replayable = true;
  try { replayLeadEvents(rows.map((r) => ({ id: r.id, sequence: Number(r.sequence), workspaceId, leadId, source: r.source, sourceEventId: r.source_event_id, occurredAt: new Date(r.occurred_at).toISOString(), type: r.event_type, data: r.payload })), workspaceId, leadId); } catch { replayable = false; }
  check("the lead's history still replays after the race", replayable);
  const lead = (await pool.query("select last_event_sequence from tandem.leads where id=$1", [leadId])).rows[0];
  const maxSeq = Number(rows[rows.length - 1].sequence);
  check("last_event_sequence is the real database sequence of the latest event", Number(lead.last_event_sequence) === maxSeq);
  const { leadId: agentLead } = await newLead("Agent Own Lead");
  currentUser = agentUser;
  await actions.markLeadWon(agentLead);
  check("an agent can still mark their own lead won", (await eventCount(agentLead, "conversion.confirmed")) === 1);
}

// 5. Trail logging as an agent still works through the tightened rules
{
  const { leadId } = await newLead("Trail Agent Co");
  currentUser = agentUser;
  await actions.logTrailVisit(leadId, { channel: "phone", confidenceRating: 6, salesStage: "Contacted", challenges: "Fleet compliance tracking" });
  const lead = (await pool.query("select sales_stage from tandem.leads where id=$1", [leadId])).rows[0];
  check("an agent can log Trail activity on their own lead", lead.sales_stage === "Contacted" && (await eventCount(leadId, "lead.stage_changed")) === 1);
  const entries = Number((await pool.query("select count(*) from tandem.trail_entries where lead_id=$1", [leadId])).rows[0].count);
  check("the Trail entry was recorded", entries === 1);
}

// 6. Lifetime commission (0.2): many payments per lead, rates by customer
// age, partial refunds, clawback recovery, the release job with many lines,
// partner deactivation to the house account, and races.
{
  const { recordPayment, recordRefund, appendLeadEvents, deactivatePartner, withTandemSession } = await import(dist("dist/db/index.js"));
  await pool.query("create table if not exists public.e2e_partners (id text primary key, active boolean not null)");
  await pool.query("grant select on public.e2e_partners to authenticated");
  const setPartner = (id, active) => pool.query("insert into public.e2e_partners values ($1, $2) on conflict (id) do update set active = excluded.active", [id, active]);
  for (const id of ["life-partner", "race-a", "race-b"]) await setPartner(id, true);
  const config = {
    qualification: { automatedSetupMaxQualificationMetric: 15 },
    commission: { holdDays: 30, rateSchedule: [{ fromMonth: 0, basisPoints: 2500 }, { fromMonth: 12, basisPoints: 2000 }] },
    partners: { houseAccountId: "house", onDeactivation: { futurePayments: "house", heldLines: "house" } },
  };
  const readPartner = (client) => async (id) => ({ id, active: (await client.query("select active from public.e2e_partners where id = $1", [id])).rows[0]?.active ?? false });
  const asOwner = (fn) => withTandemSession(pool, owner, fn);
  const lifeLead = (name, partnerId) => insertLead({ name, assigneeId: agentId, events: [
    ["lead.created", { companyName: name, qualificationMetric: 1, qualification: "Automated_Setup", partnerId }, iso(-600)],
    ["conversion.confirmed", {}, iso(-599)],
  ] });
  const pay = (leadId, paymentId, amountMinor, confirmedAt, partnerStatus) => asOwner((client) => recordPayment(client, {
    workspaceId, leadId, payment: { paymentId, amountMinor, currency: "MYR", confirmedAt }, config,
    partnerStatus: partnerStatus ?? readPartner(client), source: "stripe", actor: { role: "owner" },
  }));
  const lines = async (leadId) => (await pool.query("select * from tandem.payouts where lead_id = $1 order by payment_confirmed_at, id", [leadId])).rows;
  const line = async (leadId, paymentId) => (await pool.query("select * from tandem.payouts where lead_id = $1 and payment_id = $2", [leadId, paymentId])).rows[0];
  const history = async (leadId) => {
    const rows = (await pool.query("select id, sequence, event_type, payload, occurred_at, source, source_event_id from tandem.events where lead_id = $1 order by sequence", [leadId])).rows;
    try {
      return replayLeadEvents(rows.map((r) => ({ id: r.id, sequence: Number(r.sequence), workspaceId, leadId, source: r.source, sourceEventId: r.source_event_id, occurredAt: new Date(r.occurred_at).toISOString(), type: r.event_type, data: r.payload })), workspaceId, leadId);
    } catch { return null; }
  };
  const leadStatus = async (leadId) => (await pool.query("select pipeline_status from tandem.leads where id = $1", [leadId])).rows[0].pipeline_status;
  // The projection must always equal a fresh replay of the log.
  const projectionMatches = async (leadId) => {
    const state = await history(leadId);
    if (!state) return false;
    const rows = await lines(leadId);
    if (rows.length !== state.commissions.length || (await leadStatus(leadId)) !== state.status) return false;
    return state.commissions.every((l) => {
      const r = rows.find((row) => row.id === l.payoutId);
      return r && r.status === l.status && Number(r.amount_minor) === l.amountMinor && r.partner_id === l.partnerId
        && r.beneficiary === l.beneficiary && Number(r.clawback_amount_minor ?? 0) === (l.clawback?.amountMinor ?? 0)
        && Number(r.clawback_recovered_minor) === (l.clawback?.recoveredMinor ?? 0);
    });
  };

  // 6a. Two different payments at once on one lead
  const { leadId: monthly } = await lifeLead("Monthly Co", "life-partner");
  const both = await Promise.allSettled([pay(monthly, "inv_a", 9990, iso(-100)), pay(monthly, "inv_b", 9990, iso(-70))]);
  check("two simultaneous payments on one lead both record, each with its own line", both.every((r) => r.status === "fulfilled") && (await lines(monthly)).length === 2);
  check("the lead's history replays and matches the projection after concurrent payments", await projectionMatches(monthly));

  // 6b. The same payment id, retried in sequence and at the same time
  const again = await pay(monthly, "inv_a", 9990, iso(-100));
  check("a retried payment id is recognised and writes nothing", again.alreadyRecorded === true && (await eventCount(monthly, "payment.confirmed")) === 2);
  const twin = await Promise.allSettled([pay(monthly, "inv_c", 9990, iso(-10)), pay(monthly, "inv_c", 9990, iso(-10))]);
  const twinFulfilled = twin.filter((r) => r.status === "fulfilled").map((r) => r.value);
  check("the same payment id sent twice at once records once", twinFulfilled.length === 2 && twinFulfilled.filter((v) => v.alreadyRecorded).length === 1
    && (await eventCount(monthly, "payment.confirmed")) === 3 && (await lines(monthly)).length === 3);

  // 6c. Rate change exactly at the 12-month anniversary
  const now = new Date();
  const since = Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() - 3, 15, 10);
  const anniversary = new Date(since); anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  const { leadId: yearly } = await lifeLead("Anniversary Co", "life-partner");
  await pay(yearly, "y1", 10000, new Date(since).toISOString());
  await pay(yearly, "y1-last", 10000, new Date(anniversary.getTime() - 1000).toISOString());
  await pay(yearly, "y2-first", 10000, anniversary.toISOString());
  const tiers = (await lines(yearly)).map((r) => [r.payment_id, r.basis_points, Number(r.amount_minor), r.customer_age_months]);
  check("the rate is 25% until the anniversary instant and 20% from it, with age saved on each line", JSON.stringify(tiers) === JSON.stringify([["y1", 2500, 2500, 0], ["y1-last", 2500, 2500, 11], ["y2-first", 2000, 2000, 12]]));

  // 6d. Annual prepay: one payment, one line, its own hold
  const { leadId: annual } = await lifeLead("Annual Co", "life-partner");
  const prepaidAt = iso(-5);
  await asOwner((client) => recordPayment(client, { workspaceId, leadId: annual, payment: { paymentId: "annual_1", amountMinor: 118800, currency: "MYR", confirmedAt: prepaidAt }, config, partnerStatus: readPartner(client), source: "stripe", holdDays: 60 }));
  const prepaid = await lines(annual);
  check("an annual prepay is one line, held for its own 60 days", prepaid.length === 1 && Number(prepaid[0].amount_minor) === 29700
    && new Date(prepaid[0].release_at).getTime() - new Date(prepaidAt).getTime() === 60 * 86400000);

  // 6e. The release job with many due lines on one lead (0.1's job raised on the second)
  const released = (await pool.query("select payout_id from tandem.release_due_commissions()")).rows.map((r) => r.payout_id);
  const yearlyLines = await lines(yearly);
  check("the release job releases every due line on one lead in a single run", yearlyLines.every((r) => r.status === "eligible" && released.includes(r.id)));
  check("a lead with several eligible lines is Commission_Eligible and still matches its history", (await leadStatus(yearly)) === "Commission_Eligible" && await projectionMatches(yearly) && await projectionMatches(monthly));
  check("a line that is not due yet stays held", (await line(monthly, "inv_c")).status === "held" && (await line(annual, "annual_1")).status === "held");

  // 6f. Approve and pay one line of many; a double click pays once
  currentUser = owner;
  const target = await line(yearly, "y1-last");
  await actions.approveCommission(yearly, target.id);
  adapterCalls = []; adapterDelayMs = 300;
  const payTwice = await Promise.allSettled([actions.payCommission(yearly, target.id), actions.payCommission(yearly, target.id)]);
  adapterDelayMs = 0;
  check("paying one line of many twice at once sends exactly one transfer", adapterCalls.length === 1 && payTwice.filter((r) => r.status === "fulfilled").length === 1);
  check("the transfer used that line's own partner, amount and payment", adapterCalls[0]?.partnerId === "life-partner" && adapterCalls[0]?.amountMinor === 2500 && adapterCalls[0]?.paymentId === "y1-last" && adapterCalls[0]?.beneficiary === "partner");
  check("only that line is paid; the others are untouched", (await lines(yearly)).map((r) => r.status).join() === "eligible,paid,eligible");

  // 6g. Partial refund before payout: proportional, retry-safe, exact at the end
  await asOwner((client) => recordRefund(client, { workspaceId, leadId: monthly, paymentId: "inv_c", refundId: "re_1", amountMinor: 3330, reason: "pro rata", source: "stripe" }));
  const retryRefund = await asOwner((client) => recordRefund(client, { workspaceId, leadId: monthly, paymentId: "inv_c", refundId: "re_1", amountMinor: 3330, reason: "pro rata", source: "stripe" }));
  // 2498 * 3330 / 9990 = 832.67 -> 833 off
  check("a partial refund reduces the unpaid line in proportion, and a retried refund changes nothing", Number((await line(monthly, "inv_c")).amount_minor) === 1665 && retryRefund.skipped === 1 && (await eventCount(monthly, "payment.refunded")) === 1);
  await asOwner((client) => recordRefund(client, { workspaceId, leadId: monthly, paymentId: "inv_c", refundId: "re_2", amountMinor: 6660, reason: "rest", source: "stripe" }));
  check("refunding the rest voids the line, and the lead is not marked refunded while other payments stand", (await line(monthly, "inv_c")).status === "voided" && (await leadStatus(monthly)) === "Commission_Eligible" && await projectionMatches(monthly));

  // 6h. Partial refund after payout becomes a clawback; recovery is bounded
  await asOwner((client) => recordRefund(client, { workspaceId, leadId: yearly, paymentId: "y1-last", refundId: "re_3", amountMinor: 5000, reason: "half refund", source: "stripe" }));
  check("a partial refund after payout adds to the line's clawback", Number((await line(yearly, "y1-last")).clawback_amount_minor) === 1250 && (await line(yearly, "y1-last")).status === "paid");
  await asOwner((client) => appendLeadEvents(client, { workspaceId, leadId: yearly, actor: { role: "owner" }, events: [{ type: "commission.clawback_recovered", data: { payoutId: target.id, amountMinor: 1000, reference: "deducted" } }] }));
  check("recovering part of a clawback is recorded on the line", Number((await line(yearly, "y1-last")).clawback_recovered_minor) === 1000 && await projectionMatches(yearly));
  check("recovering more than is owed is rejected", await rejects(() => asOwner((client) => appendLeadEvents(client, { workspaceId, leadId: yearly, events: [{ type: "commission.clawback_recovered", data: { payoutId: target.id, amountMinor: 251, reference: "x" } }] })), /cannot exceed/));

  // 6i. Deactivating the partner moves unpaid lines to the house account
  const thirdLine = await line(yearly, "y2-first");
  await actions.approveCommission(yearly, thirdLine.id);
  await setPartner("life-partner", false);
  const sweep = await asOwner((client) => deactivatePartner(client, { workspaceId, partnerId: "life-partner", config, reason: "left the program", actor: { role: "owner" } }));
  const afterSweep = (await lines(yearly)).map((r) => [r.payment_id, r.partner_id, r.beneficiary, r.status, r.original_partner_id]);
  check("deactivation moves unpaid lines to the house, sends approved ones back to eligible, and leaves paid lines alone",
    JSON.stringify(afterSweep) === JSON.stringify([
      ["y1", "house", "house", "eligible", "life-partner"], ["y1-last", "life-partner", "partner", "paid", "life-partner"], ["y2-first", "house", "house", "eligible", "life-partner"],
    ]) && (await line(monthly, "inv_c")).status === "voided" && (await line(annual, "annual_1")).partner_id === "house" && sweep.leadsChanged === 3);
  const sweepAgain = await asOwner((client) => deactivatePartner(client, { workspaceId, partnerId: "life-partner", config }));
  check("running the sweep again changes nothing", sweepAgain.eventsAppended === 0);
  await actions.approveCommission(yearly, thirdLine.id);
  adapterCalls = [];
  await actions.payCommission(yearly, thirdLine.id);
  check("a transferred line can only ever be paid to the house account", adapterCalls.length === 1 && adapterCalls[0].partnerId === "house" && adapterCalls[0].beneficiary === "house");
  await pay(monthly, "inv_d", 9990, iso(-2));
  check("a payment after deactivation goes to the house account under the policy", (await line(monthly, "inv_d")).beneficiary === "house" && (await line(monthly, "inv_d")).original_partner_id === "life-partner");

  // 6j. Reactivation
  await setPartner("life-partner", true);
  await pay(monthly, "inv_e", 9990, iso(-1));
  check("after reactivation new payments go to the partner again, and moved lines stay with the house", (await line(monthly, "inv_e")).partner_id === "life-partner" && (await line(monthly, "inv_d")).partner_id === "house" && await projectionMatches(monthly));

  // 6k. A payment racing a deactivation always ends with the policy result.
  // A: the payment reads the partner's status after the deactivation commits.
  const { leadId: raceA } = await lifeLead("Race A Co", "race-a");
  const slowRead = (client) => async (id) => { await new Promise((r) => setTimeout(r, 400)); return readPartner(client)(id); };
  const paymentA = pay(raceA, "race_a_1", 9990, iso(-1), undefined);
  const paymentASlow = asOwner((client) => recordPayment(client, { workspaceId, leadId: raceA, payment: { paymentId: "race_a_2", amountMinor: 9990, currency: "MYR", confirmedAt: iso(0) }, config, partnerStatus: slowRead(client), source: "stripe" }));
  await paymentA;
  await new Promise((r) => setTimeout(r, 100));
  await setPartner("race-a", false);
  await asOwner((client) => deactivatePartner(client, { workspaceId, partnerId: "race-a", config }));
  await paymentASlow;
  // B: the payment reads "active" before the deactivation commits, and the
  // sweep, blocked on the lead lock, moves the line once the payment commits.
  const { leadId: raceB } = await lifeLead("Race B Co", "race-b");
  const earlyRead = (client) => async (id) => { const s = await readPartner(client)(id); await new Promise((r) => setTimeout(r, 400)); return s; };
  const paymentB = asOwner((client) => recordPayment(client, { workspaceId, leadId: raceB, payment: { paymentId: "race_b_1", amountMinor: 9990, currency: "MYR", confirmedAt: iso(0) }, config, partnerStatus: earlyRead(client), source: "stripe" }));
  await new Promise((r) => setTimeout(r, 100));
  await setPartner("race-b", false);
  await asOwner((client) => deactivatePartner(client, { workspaceId, partnerId: "race-b", config }));
  await paymentB;
  check("a payment racing a deactivation ends with the house account, whichever side reads first",
    (await line(raceA, "race_a_1")).beneficiary === "house" && (await line(raceA, "race_a_2")).beneficiary === "house" && (await line(raceB, "race_b_1")).beneficiary === "house"
    && await projectionMatches(raceA) && await projectionMatches(raceB));

  // 6l. Agents cannot touch any of this
  const partnerLineId = (await line(monthly, "inv_e")).id;
  check("an agent cannot record a payment", await rejects(() => withTandemSession(pool, agentUser, (client) => recordPayment(client, { workspaceId, leadId: monthly, payment: { paymentId: "agent_pay", amountMinor: 1, currency: "MYR", confirmedAt: iso(0) }, config, partnerStatus: readPartner(client), source: "stripe", actor: { role: "agent" } })), /owner or admin/));
  check("an agent cannot move a line to another account", await rejects(() => withTandemSession(pool, agentUser, (client) => appendLeadEvents(client, { workspaceId, leadId: monthly, actor: { role: "agent" }, events: [{ type: "commission.transferred", data: { payoutId: partnerLineId, toPartnerId: "agent", reason: "mine" } }] })), /owner or admin/));
  check("without the app check, the database still refuses an agent's money event", await rejects(() => withTandemSession(pool, agentUser, (client) => appendLeadEvents(client, { workspaceId, leadId: monthly, events: [{ type: "commission.transferred", data: { payoutId: partnerLineId, toPartnerId: "agent", reason: "mine" } }] }))));
  check("the agent attempts left the line with the partner", (await line(monthly, "inv_e")).partner_id === "life-partner" && await projectionMatches(monthly));
}

await pool.end();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll end-to-end checks passed");
process.exit(failures ? 1 : 0);
