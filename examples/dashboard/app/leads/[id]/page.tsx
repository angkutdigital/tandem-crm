import Link from "next/link";

import { TrailActivity } from "@/components/trail-activity";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getLeadDetail, getTrailEntries, requireCurrentMember } from "@/lib/queries";

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ");
}

const statusVariantMap: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Automated_Setup: "outline",
  Manual_Review: "outline",
  Won: "secondary",
  Commission_Hold: "secondary",
  Commission_Eligible: "secondary",
  Commission_Paid: "default",
  Lost: "destructive",
  Refunded: "destructive",
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function LeadDetailPage(props: PageProps<"/leads/[id]">) {
  const { id } = await props.params;
  const member = await requireCurrentMember();
  const [lead, trailEntries] = await Promise.all([
    getLeadDetail(member.userId, id),
    getTrailEntries(member.userId, id),
  ]);

  if (!lead) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Lead not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <Link href="/leads" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Back to leads
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{lead.companyName}</h1>
          <Badge variant={statusVariantMap[lead.pipelineStatus] ?? "outline"}>
            {humanizeStatus(lead.pipelineStatus)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Last updated {formatDate(lead.updatedAt)}
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription className="text-xs font-medium tracking-wide uppercase">
              Assignee
            </CardDescription>
            <CardTitle className="text-lg font-semibold">
              {lead.assigneeName ?? "Unassigned"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="text-xs font-medium tracking-wide uppercase">
              Qualification metric
            </CardDescription>
            <CardTitle className="text-lg font-semibold tabular-nums">
              {lead.qualificationMetric}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="text-xs font-medium tracking-wide uppercase">
              Status
            </CardDescription>
            <CardTitle className="text-lg font-semibold">
              {humanizeStatus(lead.pipelineStatus)}
            </CardTitle>
          </CardHeader>
        </Card>
      </section>

      <Card>
        <CardContent className="pt-(--card-spacing)">
          <TrailActivity leadId={lead.id} entries={trailEntries} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Event history</CardTitle>
          <CardDescription>
            Every business event recorded for this lead, in append order.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {lead.events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No events recorded yet.
            </p>
          ) : (
            <ol className="flex flex-col gap-4">
              {lead.events.map((event) => (
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
    </div>
  );
}
