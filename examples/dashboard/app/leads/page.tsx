import Link from "next/link";

import { AddLeadDialog } from "@/components/add-lead-dialog";
import { LeadsKanbanBoard } from "@/components/leads-kanban-board";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "cn";
import { getLeads, getLeadsPage, requireCurrentMember, type LeadSummary } from "@/lib/queries";

const PAGE_SIZE = 10;
const MAX_PAGE_LINKS = 5;

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

/** The window of page numbers to show, centered on the current page and
 * clamped to the total page count. */
function pageWindow(current: number, totalPages: number): number[] {
  const size = Math.min(MAX_PAGE_LINKS, totalPages);
  let start = Math.max(1, current - Math.floor(size / 2));
  const end = Math.min(totalPages, start + size - 1);
  start = Math.max(1, end - size + 1);
  const pages: number[] = [];
  for (let page = start; page <= end; page++) pages.push(page);
  return pages;
}

function LeadsPagination({ page, total }: { page: number; total: number }) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (totalPages <= 1) return null;

  const hrefFor = (target: number) => `/leads?view=list&page=${target}`;
  const isFirst = page <= 1;
  const isLast = page >= totalPages;

  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          {isFirst ? (
            <PaginationPrevious aria-disabled="true" className="pointer-events-none opacity-50" />
          ) : (
            <PaginationPrevious href={hrefFor(page - 1)} />
          )}
        </PaginationItem>
        {pageWindow(page, totalPages).map((target) => (
          <PaginationItem key={target}>
            <PaginationLink href={hrefFor(target)} isActive={target === page}>
              {target}
            </PaginationLink>
          </PaginationItem>
        ))}
        <PaginationItem>
          {isLast ? (
            <PaginationNext aria-disabled="true" className="pointer-events-none opacity-50" />
          ) : (
            <PaginationNext href={hrefFor(page + 1)} />
          )}
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

function LeadsList({
  leads,
  total,
  page,
}: {
  leads: LeadSummary[];
  total: number;
  page: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>All leads</CardTitle>
        <CardDescription>
          {total === 0 ? "No leads yet" : `${total} lead${total === 1 ? "" : "s"}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
        <LeadsPagination page={page} total={total} />
      </CardContent>
    </Card>
  );
}


export default async function LeadsPage(props: PageProps<"/leads">) {
  const { view, page: pageParam } = await props.searchParams;
  const activeView = view === "kanban" ? "kanban" : "list";

  const parsedPage = Number(Array.isArray(pageParam) ? pageParam[0] : pageParam);
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;

  const member = await requireCurrentMember();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
      </header>

      <div className="flex items-center justify-between gap-4">
        <ViewToggle activeView={activeView} />
        <AddLeadDialog />
      </div>

      {activeView === "kanban" ? (
        <LeadsKanbanBoard leads={await getLeads(member.userId)} />
      ) : (
        await (async () => {
          const { leads, total, page: resolvedPage } = await getLeadsPage(
            member.userId,
            page,
            PAGE_SIZE
          );
          return <LeadsList leads={leads} total={total} page={resolvedPage} />;
        })()
      )}
    </div>
  );
}
