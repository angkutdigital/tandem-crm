"use client";

import { useState, useTransition } from "react";
import { Mail, MapPin, MessageCircle, Phone, Pencil, Plus, RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { correctTrailEntry, logTrailVisit, retractTrailEntry, type TrailInput } from "../actions.js";
import type { TrailEntrySummary } from "../queries.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Textarea } from "./ui/textarea.js";

const STAGES = ["New", "Contacted", "Qualified", "Negotiating", "Closed_Won", "Closed_Lost"] as const;
const CHANNELS = ["phone", "whatsapp", "physical", "email"] as const;

/** CHAMP: Challenges, Authority, Money, Prioritization. Every field is
 * optional (see src/trail.ts's own comment on why the domain reducer can
 * never require them) -- an agent fills in whatever they actually learned
 * on this interaction, not a mandatory checklist. */
const CHAMP_FIELDS = [
  { key: "challenges" as const, label: "Challenges", placeholder: "What workflow problem are they trying to solve right now?" },
  { key: "authority" as const, label: "Authority", placeholder: "Who has the final say, or who else needs to be looped in?" },
  { key: "budget" as const, label: "Money", placeholder: "What does their realistic buying power look like?" },
  { key: "prioritization" as const, label: "Prioritization", placeholder: "Where does this rank on their own timeline right now?" },
];

const EMPTY_FORM: TrailInput = {
  channel: "phone",
  confidenceRating: 5,
  salesStage: "Contacted",
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-MY", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function ChannelIcon({ channel }: { channel: TrailEntrySummary["channel"] }) {
  const Icon = channel === "phone" ? Phone : channel === "email" ? Mail : channel === "whatsapp" ? MessageCircle : MapPin;
  return <Icon aria-hidden="true" className="size-4" />;
}

function ActivityForm({
  initial,
  onSubmit,
  submitLabel,
  pending,
}: {
  initial: TrailInput;
  onSubmit: (value: TrailInput) => void;
  submitLabel: string;
  pending: boolean;
}) {
  const [form, setForm] = useState(initial);
  const trimmedOrUndefined = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          ...form,
          note: trimmedOrUndefined(form.note),
          challenges: trimmedOrUndefined(form.challenges),
          authority: trimmedOrUndefined(form.authority),
          budget: trimmedOrUndefined(form.budget),
          prioritization: trimmedOrUndefined(form.prioritization),
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="trail-channel">Interaction type</Label>
          <select
            id="trail-channel"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={form.channel}
            onChange={(event) => setForm((value) => ({ ...value, channel: event.target.value as TrailInput["channel"] }))}
          >
            {CHANNELS.map((channel) => <option key={channel} value={channel}>{humanize(channel)}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="trail-stage">Sales stage</Label>
          <select
            id="trail-stage"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={form.salesStage}
            onChange={(event) => setForm((value) => ({ ...value, salesStage: event.target.value as TrailInput["salesStage"] }))}
          >
            {STAGES.map((stage) => <option key={stage} value={stage}>{humanize(stage)}</option>)}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="trail-confidence">Confidence (1–10)</Label>
        <Input
          id="trail-confidence"
          min="1"
          max="10"
          type="number"
          value={form.confidenceRating}
          onChange={(event) => setForm((value) => ({ ...value, confidenceRating: Number(event.target.value) }))}
          required
        />
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">CHAMP qualification</p>
        {CHAMP_FIELDS.map((field) => (
          <div key={field.key} className="flex flex-col gap-2">
            <Label htmlFor={`trail-${field.key}`}>{field.label}</Label>
            <Textarea
              id={`trail-${field.key}`}
              value={form[field.key] ?? ""}
              onChange={(event) => setForm((value) => ({ ...value, [field.key]: event.target.value }))}
              placeholder={field.placeholder}
              rows={2}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="trail-note">Additional notes</Label>
        <Textarea
          id="trail-note"
          value={form.note ?? ""}
          onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
          placeholder="Anything else worth capturing that doesn't fit CHAMP."
          rows={2}
        />
      </div>
      <p className="text-xs text-muted-foreground">Fill in at least one field above -- CHAMP or notes.</p>
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditActivityDialog({ entry, leadId }: { entry: TrailEntrySummary; leadId: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Correct activity" />}>
        <Pencil aria-hidden="true" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct activity</DialogTitle>
          <DialogDescription>
            This adds a correction to the activity record; it does not erase the original interaction.
          </DialogDescription>
        </DialogHeader>
        <ActivityForm
          initial={{
            channel: entry.channel, confidenceRating: entry.confidenceRating, salesStage: entry.salesStage,
            note: entry.note ?? undefined, challenges: entry.challenges ?? undefined, authority: entry.authority ?? undefined,
            budget: entry.budget ?? undefined, prioritization: entry.prioritization ?? undefined,
          }}
          pending={isPending}
          submitLabel="Save correction"
          onSubmit={(input) => startTransition(async () => {
            try {
              await correctTrailEntry(leadId, entry.id, input);
              setOpen(false);
              toast.success("Activity corrected");
            } catch (error) {
              toast.error(getErrorMessage(error, "Could not correct activity"));
            }
          })}
        />
      </DialogContent>
    </Dialog>
  );
}

function RetractActivityButton({ entry, leadId }: { entry: TrailEntrySummary; leadId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      aria-label="Retract activity"
      variant="ghost"
      size="icon-sm"
      disabled={isPending}
      onClick={() => startTransition(async () => {
        try {
          await retractTrailEntry(leadId, entry.id);
          toast.success("Activity retracted");
        } catch (error) {
          toast.error(getErrorMessage(error, "Could not retract activity"));
        }
      })}
    >
      {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <RotateCcw aria-hidden="true" />}
    </Button>
  );
}

/** One CHAMP field, shown only if the agent actually filled it in --
 * pre-CHAMP entries have none of these, and that's a normal, permanent
 * state for that historical row, not a loading/missing-data condition. */
function ChampRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

export function TrailActivity({ leadId, entries }: { leadId: string; entries: TrailEntrySummary[] }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <section className="flex flex-col gap-4" aria-labelledby="activity-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="activity-heading" className="font-heading text-base font-medium">Activity</h2>
          <p className="text-sm text-muted-foreground">Keep the relationship context beside the lead, without a separate CRM system.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>
            <Plus aria-hidden="true" />
            Log activity
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Log activity</DialogTitle>
              <DialogDescription>Record an interaction and what you learned using CHAMP.</DialogDescription>
            </DialogHeader>
            <ActivityForm
              initial={EMPTY_FORM}
              pending={isPending}
              submitLabel="Log activity"
              onSubmit={(input) => startTransition(async () => {
                try {
                  await logTrailVisit(leadId, input);
                  setOpen(false);
                  toast.success("Activity logged");
                } catch (error) {
                  toast.error(getErrorMessage(error, "Could not log activity"));
                }
              })}
            />
          </DialogContent>
        </Dialog>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          No activity yet. Log the first conversation, email, or site visit.
        </div>
      ) : (
        <ol className="relative flex flex-col gap-4 border-l pl-5">
          {[...entries].reverse().map((entry) => (
            <li key={entry.id} className="relative rounded-xl border bg-card p-4 shadow-xs">
              <span className="absolute -left-[1.82rem] top-5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground">
                <ChannelIcon channel={entry.channel} />
              </span>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={entry.retracted ? "outline" : "secondary"}>{humanize(entry.salesStage)}</Badge>
                  <span className="text-xs text-muted-foreground">{humanize(entry.channel)} · confidence {entry.confidenceRating}/10</span>
                  {entry.correctedAt && <span className="text-xs text-muted-foreground">corrected</span>}
                  {entry.retracted && <span className="text-xs text-destructive">retracted</span>}
                </div>
                <div className="flex items-center gap-1">
                  <time className="text-xs text-muted-foreground">{formatDateTime(entry.loggedAt)}</time>
                  {!entry.retracted && <>
                    <EditActivityDialog entry={entry} leadId={leadId} />
                    <RetractActivityButton entry={entry} leadId={leadId} />
                  </>}
                </div>
              </div>
              <div className={entry.retracted ? "mt-3 flex flex-col gap-2 opacity-60" : "mt-3 flex flex-col gap-2"}>
                {(entry.challenges || entry.authority || entry.budget || entry.prioritization) && (
                  <div className="grid gap-2 rounded-lg bg-muted/40 p-2.5 sm:grid-cols-2">
                    <ChampRow label="Challenges" value={entry.challenges} />
                    <ChampRow label="Authority" value={entry.authority} />
                    <ChampRow label="Money" value={entry.budget} />
                    <ChampRow label="Prioritization" value={entry.prioritization} />
                  </div>
                )}
                {entry.note && (
                  <p className={entry.retracted ? "text-sm text-muted-foreground line-through" : "text-sm"}>{entry.note}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
