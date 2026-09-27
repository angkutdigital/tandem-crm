-- Adds CHAMP (Challenges, Authority, Money, Prioritization) as structured
-- fields on Trail's visit-report entry, and a "whatsapp" channel alongside
-- phone/physical/email -- see src/trail.ts's module comment for why every
-- field here, CHAMP included, stays nullable rather than required: this
-- table already has real rows from before CHAMP existed, and a NOT NULL
-- constraint here would reject that legitimate historical data outright,
-- not just at the application layer but at every future INSERT the
-- projection writer performs to update an existing row's other columns.
--
-- `note` becomes nullable for the same reason as the read direction: a new
-- entry can now be CHAMP fields alone with no free-text note, so the
-- database's own floor has to match src/trail.ts's validateFields --
-- "at least one of the five fields has content" -- not "note specifically
-- is required", which is now stricter than what the application actually
-- accepts.
alter table tandem.trail_entries
  drop constraint trail_entries_channel_check,
  add constraint trail_entries_channel_check check (channel in ('phone', 'physical', 'email', 'whatsapp'));

alter table tandem.trail_entries
  drop constraint trail_entries_note_check,
  alter column note drop not null;

alter table tandem.trail_entries
  add column challenges text,
  add column authority text,
  add column budget text,
  add column prioritization text;

alter table tandem.trail_entries
  add constraint trail_entries_has_content_check check (
    coalesce(btrim(note), '') <> ''
    or coalesce(btrim(challenges), '') <> ''
    or coalesce(btrim(authority), '') <> ''
    or coalesce(btrim(budget), '') <> ''
    or coalesce(btrim(prioritization), '') <> ''
  );

-- Every existing row already has a non-empty note (the old NOT NULL check
-- guaranteed it), so this new constraint is satisfied by every row that
-- already exists -- nothing to backfill, this is a pure schema widening.
