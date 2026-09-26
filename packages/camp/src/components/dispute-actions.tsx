"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { executeDisputeOutcome, queryDispute, resolveDispute } from "../actions.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.js";

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export function QueryDisputeForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        await queryDispute(disputeId, question);
        setQuestion("");
        router.refresh();
      } catch (err) {
        toast.error(errorMessage(err, "Could not send the query"));
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="dispute-question">Ask for more information</Label>
        <textarea
          id="dispute-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          required
          rows={3}
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      <Button type="submit" size="sm" className="self-start" disabled={isPending}>
        {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
        Send query
      </Button>
    </form>
  );
}

export function ResolveDisputeForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<"upheld" | "dismissed">("upheld");
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        await resolveDispute(disputeId, outcome, note);
        setNote("");
        router.refresh();
      } catch (err) {
        toast.error(errorMessage(err, "Could not resolve the dispute"));
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="dispute-outcome">Resolve dispute</Label>
        <Select
          value={outcome}
          onValueChange={(value) => setOutcome(value as "upheld" | "dismissed")}
        >
          <SelectTrigger id="dispute-outcome" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="upheld">Upheld</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="dispute-resolution-note">Resolution note</Label>
        <textarea
          id="dispute-resolution-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          required
          rows={3}
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      <Button type="submit" size="sm" className="self-start" disabled={isPending}>
        {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
        Resolve
      </Button>
    </form>
  );
}

export function ExecuteOutcomeForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [action, setAction] = useState<"adjust" | "reinstate" | "clawback">("adjust");
  const [amount, setAmount] = useState("");
  const [reasonOrReleaseAt, setReasonOrReleaseAt] = useState("");
  const [isPending, startTransition] = useTransition();

  const needsReasonOrReleaseAt = action === "reinstate" || action === "clawback";

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        // The reinstate branch's <input type="datetime-local"> gives a local
        // string like "2026-09-26T14:30" (no seconds, no timezone), but the
        // domain reducer requires a full ISO 8601 instant -- convert before
        // it ever reaches the server action, or every reinstate throws
        // "timestamp must be an ISO 8601 instant".
        const value =
          action === "reinstate" && reasonOrReleaseAt
            ? new Date(reasonOrReleaseAt).toISOString()
            : reasonOrReleaseAt;
        await executeDisputeOutcome(
          disputeId,
          action,
          Number(amount),
          needsReasonOrReleaseAt ? value : ""
        );
        setAmount("");
        setReasonOrReleaseAt("");
        router.refresh();
      } catch (err) {
        toast.error(errorMessage(err, "Could not apply the outcome"));
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="dispute-action">Action</Label>
        <Select
          value={action}
          onValueChange={(value) =>
            setAction(value as "adjust" | "reinstate" | "clawback")
          }
        >
          <SelectTrigger id="dispute-action" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="adjust">Adjust amount</SelectItem>
            <SelectItem value="reinstate">Reinstate</SelectItem>
            <SelectItem value="clawback">Request clawback</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="dispute-amount">Amount (minor units, e.g. cents)</Label>
        <Input
          id="dispute-amount"
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </div>
      {needsReasonOrReleaseAt ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="dispute-reason">
            {action === "reinstate" ? "Release date (ISO)" : "Reason"}
          </Label>
          <Input
            id="dispute-reason"
            type={action === "reinstate" ? "datetime-local" : "text"}
            value={reasonOrReleaseAt}
            onChange={(e) => setReasonOrReleaseAt(e.target.value)}
            required
          />
        </div>
      ) : null}
      <Button type="submit" size="sm" className="self-start" disabled={isPending}>
        {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
        Apply
      </Button>
    </form>
  );
}
