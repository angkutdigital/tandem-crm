import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDisputes, requireCurrentMember, type DisputeSummary } from "@/lib/queries";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatCategory(category: DisputeSummary["category"]) {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

const statusVariantMap: Record<
  DisputeSummary["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  open: "outline",
  queried: "secondary",
  resolved: "default",
};

const outcomeVariantMap: Record<
  NonNullable<DisputeSummary["outcome"]>,
  "default" | "secondary" | "outline" | "destructive"
> = {
  upheld: "destructive",
  dismissed: "outline",
};

export default async function DisputesPage() {
  const member = await requireCurrentMember();
  const disputes = await getDisputes(member.userId);

  const openCount = disputes.filter((dispute) => dispute.status !== "resolved").length;
  const description =
    disputes.length === 0
      ? "No disputes"
      : `${openCount} open · ${disputes.length} total`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Disputes</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>All disputes</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {disputes.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No disputes yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Opened by</TableHead>
                  <TableHead>Opened date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {disputes.map((dispute) => (
                  <TableRow key={dispute.id}>
                    <TableCell>
                      <Link
                        href={`/disputes/${dispute.id}`}
                        className="font-medium hover:underline"
                      >
                        {dispute.companyName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{formatCategory(dispute.category)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariantMap[dispute.status]}>
                        {formatCategory(dispute.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {dispute.outcome ? (
                        <Badge variant={outcomeVariantMap[dispute.outcome]}>
                          {formatCategory(dispute.outcome)}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{dispute.openedByAgentName}</TableCell>
                    <TableCell>{formatDate(dispute.openedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
