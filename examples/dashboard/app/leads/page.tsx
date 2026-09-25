import Link from "next/link";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "cn";
import { getLeads, requireCurrentMember, type LeadSummary } from "@/lib/queries";

const PIPELINE_STATUSES = [
  "Automated_Setup",
  "Manual_Review",
  "Won",
  "Commission_Hold",
  "Commission_Eligible",
  "Commission_Paid",
  "Lost",
  "Refunded",
] as const;

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ");
}

function formatUpdatedDate(updatedAt: string) {
  return new Date(updatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function initialsOf(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
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

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariantMap[status] ?? "outline"}>
      {humanizeStatus(status)}
    </Badge>
  );
}

function ViewToggle({ activeView }: { activeView: "list" | "kanban" }) {
  const linkClass = (view: "list" | "kanban") =>
    cn(
      "rounded-md px-3 py-1 text-sm font-medium transition-colors",
      activeView === view
        ? "bg-background text-foreground shadow-sm"
        : "text-muted-foreground hover:text-foreground"
    );

  return (
    <div className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-[3px]">
      <Link href="/leads?view=list" className={linkClass("list")}>
        List
      </Link>
      <Link href="/leads?view=kanban" className={linkClass("kanban")}>
        Kanban
      </Link>
    </div>
  );
}

function LeadRow({ lead }: { lead: LeadSummary }) {
  return (
    <TableRow key={lead.id}>
      <TableCell className="font-medium">
        <Link href={`/leads/${lead.id}`} className="hover:underline">
          {lead.companyName}
        </Link>
      </TableCell>
      <TableCell>
        <StatusBadge status={lead.pipelineStatus} />
      </TableCell>
      <TableCell>{lead.assigneeName ?? "Unassigned"}</TableCell>
      <TableCell className="tabular-nums">{lead.qualificationMetric}</TableCell>
      <TableCell>{formatUpdatedDate(lead.updatedAt)}</TableCell>
    </TableRow>
  );
}

function LeadsList({ leads }: { leads: LeadSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>All leads</CardTitle>
        <CardDescription>
          {leads.length === 0 ? "No leads yet" : `${leads.length} lead${leads.length === 1 ? "" : "s"}`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {leads.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No leads yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Qualification metric</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <LeadRow key={lead.id} lead={lead} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function LeadCard({ lead }: { lead: LeadSummary }) {
  return (
    <Link
      href={`/leads/${lead.id}`}
      className="flex flex-col gap-2 rounded-md border bg-card p-3 transition-colors hover:bg-muted/60"
    >
      <p className="truncate text-sm font-medium">{lead.companyName}</p>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Avatar className="size-5">
            <AvatarFallback className="text-[10px] font-medium">
              {lead.assigneeName ? initialsOf(lead.assigneeName) : "?"}
            </AvatarFallback>
          </Avatar>
          <span className="truncate text-xs text-muted-foreground">
            {lead.assigneeName ?? "Unassigned"}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{formatUpdatedDate(lead.updatedAt)}</span>
      </div>
    </Link>
  );
}

function LeadsKanban({ leads }: { leads: LeadSummary[] }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {PIPELINE_STATUSES.map((status) => {
        const columnLeads = leads.filter((lead) => lead.pipelineStatus === status);
        return (
          <div key={status} className="flex w-72 shrink-0 flex-col gap-3">
            <div className="flex items-center justify-between px-0.5">
              <h3 className="text-sm font-medium">{humanizeStatus(status)}</h3>
              <span className="text-xs tabular-nums text-muted-foreground">
                {columnLeads.length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {columnLeads.length === 0 ? (
                <p className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">
                  No leads
                </p>
              ) : (
                columnLeads.map((lead) => <LeadCard key={lead.id} lead={lead} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default async function LeadsPage(props: PageProps<"/leads">) {
  const { view } = await props.searchParams;
  const activeView = view === "kanban" ? "kanban" : "list";

  const member = await requireCurrentMember();
  const leads = await getLeads(member.userId);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
        <p className="text-sm text-muted-foreground">
          Every lead in your workspace, by pipeline status.
        </p>
      </header>

      <ViewToggle activeView={activeView} />

      {activeView === "kanban" ? <LeadsKanban leads={leads} /> : <LeadsList leads={leads} />}
    </div>
  );
}
