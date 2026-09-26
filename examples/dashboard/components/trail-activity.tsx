"use client";

import { useState, useTransition } from "react";
import { Mail, MapPin, Phone, Pencil, Plus, RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { correctTrailEntry, logTrailVisit, retractTrailEntry, type TrailInput } from "@/lib/actions";
import type { TrailEntrySummary } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STAGES = ["New", "Contacted", "Qualified", "Negotiating", "Closed_Won", "Closed_Lost"] as const;
const CHANNELS = ["phone", "physical", "email"] as const;

const EMPTY_FORM: TrailInput = {
  channel: "phone",
  confidenceRating: 5,
  salesStage: "Contacted",
  note: "",
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
  const Icon = channel === "phone" ? Phone : channel === "email" ? Mail : MapPin;
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

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ ...form, note: form.note.trim() });
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
      <div className="flex flex-col gap-2">
        <Label htmlFor="trail-note">What happened?</Label>
        <textarea
          id="trail-note"
          className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={form.note}
          onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
          placeholder="Capture the outcome, next step, or relevant context."
          required
          rows={4}
        />
      </div>
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
          initial={{ channel: entry.channel, confidenceRating: entry.confidenceRating, salesStage: entry.salesStage, note: entry.note }}
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
              <DialogDescription>Record an interaction and your current confidence in this opportunity.</DialogDescription>
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
              <p className={entry.retracted ? "mt-3 text-sm text-muted-foreground line-through" : "mt-3 text-sm"}>{entry.note}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
