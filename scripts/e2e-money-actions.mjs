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

await pool.end();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll end-to-end checks passed");
process.exit(failures ? 1 : 0);
