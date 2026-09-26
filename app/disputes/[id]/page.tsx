import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ExecuteOutcomeForm,
  QueryDisputeForm,
  ResolveDisputeForm,
} from "@/components/dispute-actions";
import { getDisputeDetail, requireCurrentMember, type DisputeDetail } from "@/lib/queries";

function formatCurrency(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCategory(category: DisputeDetail["category"]) {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

const statusVariantMap: Record<
  DisputeDetail["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  open: "outline",
  queried: "secondary",
  resolved: "default",
};

const outcomeVariantMap: Record<
  NonNullable<DisputeDetail["outcome"]>,
  "default" | "secondary" | "outline" | "destructive"
> = {
  upheld: "destructive",
  dismissed: "outline",
};

export default async function DisputeDetailPage(props: PageProps<"/disputes/[id]">) {
  const { id } = await props.params;
  const member = await requireCurrentMember();
  const dispute = await getDisputeDetail(member.userId, id);

  if (!dispute) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Dispute not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  const isManager = member.role === "owner" || member.role === "admin";
  const isOpen = dispute.status === "open" || dispute.status === "queried";
  const canExecute = dispute.status === "resolved" && dispute.outcome === "upheld";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <Link href="/disputes" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Back to disputes
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{dispute.companyName}</h1>
          <Badge variant="outline">{formatCategory(dispute.category)}</Badge>
          <Badge variant={statusVariantMap[dispute.status]}>
            {formatCategory(dispute.status)}
          </Badge>
          {dispute.outcome ? (
            <Badge variant={outcomeVariantMap[dispute.outcome]}>
              {formatCategory(dispute.outcome)}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Opened by {dispute.openedByAgentName} on {formatDateTime(dispute.openedAt)}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Dispute</CardTitle>
          <CardDescription>{dispute.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Expected amount
              </span>
              <span className="text-sm font-medium tabular-nums">
                {dispute.expectedAmountMinor === null
                  ? "—"
                  : formatCurrency(dispute.expectedAmountMinor, dispute.payoutCurrency)}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Payout amount
              </span>
              <span className="text-sm font-medium tabular-nums">
                {formatCurrency(dispute.payoutAmountMinor, dispute.payoutCurrency)}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Payout status
              </span>
              <span className="text-sm font-medium">
                {formatCategory(dispute.payoutStatus)}
              </span>
            </div>
          </div>
          {dispute.payoutClawbackAmountMinor !== null ? (
            <p className="text-sm text-muted-foreground">
              Clawback of{" "}
              {formatCurrency(dispute.payoutClawbackAmountMinor, dispute.payoutCurrency)} applied.
            </p>
          ) : null}
          {dispute.resolutionNote ? (
            <p className="text-sm text-muted-foreground">
              Resolution note: {dispute.resolutionNote}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Event history</CardTitle>
          <CardDescription>
            Every event recorded for this dispute, in append order.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dispute.events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No events recorded yet.
            </p>
          ) : (
            <ol className="flex flex-col gap-4">
              {dispute.events.map((event) => (
                <li key={event.id} className="flex flex-col gap-1.5 border-l-2 pl-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{event.type}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(event.occurredAt)}
                    </span>
                  </div>
                  {Object.keys(event.payload).length > 0 && (
                    <pre className="overflow-x-auto rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {isManager ? (
        <Card>
          <CardHeader>
            <CardTitle>Operator actions</CardTitle>
            <CardDescription>
              {isOpen
                ? "Ask the partner for more information, or resolve the dispute."
                : canExecute
                  ? "Apply the outcome of this upheld dispute."
                  : "This dispute is resolved; no further action is available."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {isOpen ? (
              <>
                <QueryDisputeForm disputeId={dispute.id} />
                <ResolveDisputeForm disputeId={dispute.id} />
              </>
            ) : canExecute ? (
              <ExecuteOutcomeForm disputeId={dispute.id} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Resolved: {dispute.outcome}
                {dispute.resolutionNote ? ` — ${dispute.resolutionNote}` : ""}
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
