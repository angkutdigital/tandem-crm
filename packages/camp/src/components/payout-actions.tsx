"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { approveCommission, payCommission } from "../actions.js";
import { Button } from "./ui/button.js";

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export function ApprovePayoutButton({ leadId, payoutId }: { leadId: string; payoutId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  function handleClick() {
    startTransition(async () => {
      try {
        await approveCommission(leadId, payoutId);
        router.refresh();
      } catch (err) {
        toast.error(errorMessage(err, "Could not approve this payout"));
      }
    });
  }
  return (
    <Button size="sm" variant="outline" onClick={handleClick} disabled={isPending}>
      {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
      Approve
    </Button>
  );
}

export function PayPayoutButton({
  leadId, payoutId, partnerId, amountMinor, currency,
}: { leadId: string; payoutId: string; partnerId: string; amountMinor: number; currency: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  function handleClick() {
    startTransition(async () => {
      try {
        await payCommission(leadId, payoutId, partnerId, amountMinor, currency);
        router.refresh();
      } catch (err) {
        toast.error(errorMessage(err, "Could not pay this commission"));
      }
    });
  }
  return (
    <Button size="sm" onClick={handleClick} disabled={isPending}>
      {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
      Pay
    </Button>
  );
}
