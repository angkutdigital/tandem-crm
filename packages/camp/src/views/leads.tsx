import { Badge } from "../components/ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious,
} from "../components/ui/pagination.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { getLeadsPage, requireCurrentMember, type LeadSummary } from "../queries.js";

const PAGE_SIZE = 10;
const MAX_PAGE_LINKS = 5;

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ");
}

function formatUpdatedDate(updatedAt: string) {
  return new Date(updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const statusVariantMap: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Automated_Setup: "outline", Manual_Review: "outline", Won: "secondary",
  Commission_Hold: "secondary", Commission_Eligible: "secondary", Commission_Paid: "default",
  Lost: "destructive", Refunded: "destructive",
};

const salesStageVariantMap: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  New: "outline", Contacted: "outline", Qualified: "secondary",
  Negotiating: "secondary", Closed_Won: "default", Closed_Lost: "destructive",
};

function LeadRow({ lead }: { lead: LeadSummary }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{lead.companyName}</TableCell>
      <TableCell>
        <Badge variant={statusVariantMap[lead.pipelineStatus] ?? "outline"}>{humanizeStatus(lead.pipelineStatus)}</Badge>
      </TableCell>
      <TableCell>
        <Badge variant={salesStageVariantMap[lead.salesStage] ?? "outline"}>{humanizeStatus(lead.salesStage)}</Badge>
      </TableCell>
      <TableCell>{lead.assigneeName ?? "Unassigned"}</TableCell>
      <TableCell className="tabular-nums">{lead.qualificationMetric}</TableCell>
      <TableCell>{formatUpdatedDate(lead.updatedAt)}</TableCell>
    </TableRow>
  );
}

function pageWindow(current: number, totalPages: number): number[] {
  const size = Math.min(MAX_PAGE_LINKS, totalPages);
  let start = Math.max(1, current - Math.floor(size / 2));
  const end = Math.min(totalPages, start + size - 1);
  start = Math.max(1, end - size + 1);
  const pages: number[] = [];
  for (let page = start; page <= end; page++) pages.push(page);
  return pages;
}

function LeadsPagination({ page, total, basePath }: { page: number; total: number; basePath: string }) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (totalPages <= 1) return null;
  const hrefFor = (target: number) => `${basePath}?page=${target}`;
  const isFirst = page <= 1;
  const isLast = page >= totalPages;
  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          {isFirst ? <PaginationPrevious aria-disabled="true" className="pointer-events-none opacity-50" /> : <PaginationPrevious href={hrefFor(page - 1)} />}
        </PaginationItem>
        {pageWindow(page, totalPages).map((target) => (
          <PaginationItem key={target}>
            <PaginationLink href={hrefFor(target)} isActive={target === page}>{target}</PaginationLink>
          </PaginationItem>
        ))}
        <PaginationItem>
          {isLast ? <PaginationNext aria-disabled="true" className="pointer-events-none opacity-50" /> : <PaginationNext href={hrefFor(page + 1)} />}
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

/**
 * Camp's Leads view. Deliberately list-only for this first migrated slice
 * (no kanban board, no lead detail page, no "New lead" dialog) -- see
 * packages/camp/README.md's migration status for what's still outstanding.
 * `basePath` is the URL this view is mounted at, needed to build its own
 * pagination links since Camp doesn't own routing (see root.tsx).
 */
export async function LeadsView({ page, basePath }: { page: number; basePath: string }) {
  const member = await requireCurrentMember();
  const { leads, total, page: resolvedPage } = await getLeadsPage(member.userId, page, PAGE_SIZE);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>All leads</CardTitle>
          <CardDescription>{total === 0 ? "No leads yet" : `${total} lead${total === 1 ? "" : "s"}`}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {leads.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No leads yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sales stage</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead>Qualification metric</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => <LeadRow key={lead.id} lead={lead} />)}
              </TableBody>
            </Table>
          )}
          <LeadsPagination page={resolvedPage} total={total} basePath={basePath} />
        </CardContent>
      </Card>
    </div>
  );
}
