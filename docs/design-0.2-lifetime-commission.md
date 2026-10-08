# Design: lifetime commission (0.2)

Status: implemented on branch `v0.2-lifetime-commission`.

## Problem

0.1 models one payment and one commission per lead. A subscription customer
pays every month for years, and the partner who referred them earns a
commission on every payment. 0.1 pays the partner once and stops.

## What changes

A lead now holds a list of payments and a list of commission lines. Each
payment can have at most one commission line. Every line has its own hold,
approval, payout, clawback and beneficiary.

Nothing about leads before payment changes. The old single `payment` and
`commission` fields on `LeadState` stay as read-only aliases for the most
recent payment and the most recent line, so 0.1 code that reads them keeps
working. New code should use `payments` and `commissions`.

## Events

Changed (all new fields optional, so 0.1 events stay valid):

| Event | New fields | Meaning |
| --- | --- | --- |
| `payment.confirmed` | `paymentId` | Idempotency key from the payment provider (a Stripe invoice id). Missing on 0.1 events, which get `legacy:<eventId>`. |
| `payment.refunded` | `paymentId`, `amountMinor` | Partial or full refund of one payment. Missing on 0.1 events, which mean "refund all of the only payment". |
| `commission.held` | `paymentId`, `beneficiary`, `originalPartnerId`, `beneficiaryReason`, `basisPoints`, `customerAgeMonths` | One line per payment, with every decision that produced it saved in the event. 0.1 events attach to the only payment. |

New:

| Event | Data | Meaning |
| --- | --- | --- |
| `commission.forfeited` | `paymentId`, `partnerId`, `reason` | No commission is owed on this payment, and why (partner inactive, policy "forfeit"). |
| `commission.transferred` | `payoutId`, `toPartnerId`, `reason` | An unpaid line moves to the house account. The original line stays in history. An approved line goes back to eligible, because the approval was for a different recipient. |
| `commission.clawback_recovered` | `payoutId`, `amountMinor`, `reference` | Money the partner owed back has been recovered (deducted or repaid). |

## Partner attribution

Commission is only planned for a lead with a partner (`partnerId` on
`lead.created`). 0.1 put the partner on `commission.held`, not on the lead,
and 0.1's Camp never set one. `lead.partner_attributed` attaches the partner
later: admin-only, once per lead, and refused if any existing line names a
different original partner. A 0.1 lead whose only line is for that same
partner can be attributed, which is the upgrade path. A payment on a lead
with no partner, or whose commission rounds to zero, gets a
`commission.skipped` event so the missing line is a recorded decision.

## Rules

**Rate by customer age.** `customerSince` is the time of the lead's first
payment, refunded or not. A payment's age is the number of whole calendar
months from `customerSince` to the payment, in UTC. Month ends are clamped:
a customer who started on 31 January reaches month 1 on 28 or 29 February.
A payment at exactly the anniversary instant is in the new tier. The rate
is the last tier in the schedule whose `fromMonth` is at or below the age.
Example schedule: `[{ fromMonth: 0, basisPoints: 2500 }, { fromMonth: 12, basisPoints: 2000 }]`.

**Rounding.** Each line is rounded half up in integer minor units (the 0.1
rule, `calculateCommissionMinor`). Half a cent or more goes to the partner.
Less stays with the business.

**Annual prepay.** It is one payment, so it gets one line with one hold.
It is released in full when the hold ends. If the host refunds part of it
later, the partial refund rules apply. A host that wants a longer refund
window on annual plans passes a longer `holdDays` for that payment.

**Partial refunds.** A refund of `r` from a payment with `R` still
unrefunded reduces that payment's line by `round_half_up(line * r / R)`.
Refunding everything that is left always reduces the line to exactly zero,
so rounding never leaves a stray cent.
- Line held, eligible or approved: the amount goes down. If it reaches zero
  the line is voided (the stored amount keeps its last positive value).
- Line paid: the reduction is added to the line's clawback, capped at the
  paid amount.
- Line voided: nothing.
- A 0.1-shaped refund (no amount) keeps the exact 0.1 behaviour.

**Clawbacks.** A clawback on a paid line is a running total: refunds add to
it, an operator's `commission.clawback_requested` adds to it, and
`commission.clawback_recovered` records what has been recovered. What the
partner still owes is `clawback - recovered`, readable from the ledger and
from `partnerBalance()`.

**Lead status.** After conversion the pipeline status is derived from the
lines: any line eligible or approved gives `Commission_Eligible`, else any
held gives `Commission_Hold`, else any paid gives `Commission_Paid`, else
`Won`. If every payment is fully refunded the lead is `Refunded`. For a lead
with one payment and one line this is exactly the 0.1 status sequence.

**Currency.** All payments on one lead use the same currency.

**House account.** Configuration:

```ts
partners: {
  houseAccountId: "house",
  onDeactivation: {
    futurePayments: "continue" | "house" | "forfeit",
    heldLines: "keep" | "house" | "void",
  },
}
```

The engine has no partner table and never decides that a partner is
inactive. The host passes the partner's status in. Two pure helpers:
- `planPaymentCommission()` decides the line (or forfeit) for one new
  payment, including the beneficiary and the reason.
- `planPartnerDeactivation()` lists the events to append to each lead when
  a partner is deactivated: `commission.transferred` for "house",
  `commission.voided` for "void", nothing for "keep". Paid lines are never
  touched.

Reactivation needs no event. New payments go to the partner again. Lines
already transferred stay with the house.

If the house account is the business itself, a host should not pay house
lines through the payout adapter. They are recorded for reporting.

## The writer moves into the package

0.1 left the "lock, replay, insert, update projections" code to each host,
and it lived twice (Camp and the reference dashboard). With many lines per
lead that code gets harder, so 0.2 ships it in `tandem-crm/db`:

- `appendLeadEvents(client, ...)`: locks the lead row, replays, validates,
  inserts with `returning sequence`, updates the lead and every changed
  payout row (rowCount checked), and writes payout ledger rows for status
  changes. Exact retries of an event already in the lead's history are
  skipped. An optional `actor` applies the agent rules in the app as well
  as in the database.
- `recordPayment(client, ...)`: the webhook entry point. Locks the lead,
  reads the partner's status after the lock, plans the line, appends the
  payment and the line together. A retried payment id returns
  `alreadyRecorded: true`.
- `deactivatePartner(client, ...)`: applies `planPartnerDeactivation()` to
  every lead with an open line for the partner, one lead lock at a time in
  id order.

Camp and the dashboard now call these instead of their own copies.

## Database (migration 022)

- `tandem.payouts`: `payment_id`, `beneficiary`, `original_partner_id`,
  `beneficiary_reason`, `basis_points`, `customer_age_months`,
  `clawback_recovered_minor`. A unique index on
  `(workspace_id, lead_id, payment_id)` stops a second line for one payment
  even if app code is wrong.
- `tandem.events`: the five new event types.
- `release_due_commissions()`: a lead can already be `Commission_Eligible`
  from another line, so the lead update accepts `Commission_Hold` or
  `Commission_Eligible`.
- Agents can only append three lead event types (migration 021), so every
  new event is admin-only already. The events insert policy also refuses
  `commission.eligible` and the "tandem-engine" source from any authenticated
  session, so only the release job (run as the schema owner) releases a line.
- `release_due_commissions()`'s idempotency key includes the line's
  `last_event_id`, so a line released, voided and reinstated can be released
  again without colliding with its first release.
- `tandem.leads.partner_id` is granted to authenticated and guarded by the
  status trigger: only an admin can change it.

## Invariants

1. Replaying any valid 0.1 history gives the same status, payment and
   commission as 0.1 did.
2. At most one commission line per payment, enforced in the reducer and by
   a unique index.
3. A line's amount never exceeds the unrefunded part of its payment.
4. A paid line's clawback never exceeds the paid amount, and recovered never
   exceeds the clawback.
5. A line is paid at most once, only from `approved`, with values read from
   the event log under the lead lock.
6. Every decision (rate, age, beneficiary, reason, release date) is stored
   in the event that made it.
7. Agents cannot append any money or partner event.
8. A payment arriving while its partner is being deactivated ends up with
   the policy result, because the partner's status is read after the lead
   lock and the sweep takes the same lock.

## Attacks tested

- Two simultaneous payments on one lead, and the same payment id sent twice
  (sequential and simultaneous).
- Partial refund before payout, after payout, and refunds that add up to
  the whole payment.
- A payment exactly at, just before and just after the 12-month boundary,
  and a 31 January start.
- Annual prepay.
- Deactivation with held, eligible, approved and paid lines under each
  policy; reactivation; a payment racing a deactivation.
- Double payout of one line, paying a transferred line to the old partner,
  paying with another lead's payout id.
- An agent appending each new event type, inserting a payout row, and
  updating a payout row.
- Old 0.1 histories replayed through the new reducer, compared field by
  field with the 0.1 reducer.
