import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApprovePayoutButton, PayPayoutButton } from "@/components/payout-actions";
import { getPayouts, requireCurrentMember, type PayoutSummary } from "@/lib/queries";

function formatCurrency(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

function formatReleaseDate(releaseAt: string) {
  return new Date(releaseAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const statusVariantMap: Record<
  PayoutSummary["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  held: "outline",
  eligible: "secondary",
  approved: "secondary",
  paid: "default",
  voided: "destructive",
};

function formatStatus(status: PayoutSummary["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default async function PayoutsPage() {
  const member = await requireCurrentMember();
  const isManager = member.role === "owner" || member.role === "admin";
  const payouts = await getPayouts(member.userId);

  const pendingPayouts = payouts.filter(
    (payout) => payout.status === "held" || payout.status === "eligible",
  );

  const totalsByCurrency = new Map<string, number>();
  for (const payout of pendingPayouts) {
    totalsByCurrency.set(
      payout.currency,
      (totalsByCurrency.get(payout.currency) ?? 0) + payout.amountMinor,
    );
  }

  const pendingTotalSummary = Array.from(totalsByCurrency.entries())
    .map(([currency, amountMinor]) => formatCurrency(amountMinor, currency))
    .join(" + ");

  const pendingDescription =
    pendingPayouts.length === 0
      ? "No pending payouts"
      : `${pendingPayouts.length} pending ${pendingTotalSummary ? `· ${pendingTotalSummary}` : ""}`.trim();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Payouts</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>All payouts</CardTitle>
          <CardDescription>{pendingDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          {payouts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No payouts yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Release date</TableHead>
                  {isManager ? <TableHead>Actions</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.map((payout) => (
                  <TableRow key={payout.id}>
                    <TableCell>{payout.companyName}</TableCell>
                    <TableCell>{formatCurrency(payout.amountMinor, payout.currency)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariantMap[payout.status]}>
                        {formatStatus(payout.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatReleaseDate(payout.releaseAt)}</TableCell>
                    {isManager ? (
                      <TableCell>
                        {payout.status === "eligible" ? (
                          <ApprovePayoutButton leadId={payout.leadId} payoutId={payout.id} />
                        ) : null}
                        {payout.status === "approved" ? (
                          <PayPayoutButton
                            leadId={payout.leadId}
                            payoutId={payout.id}
                            partnerId={payout.partnerId}
                            amountMinor={payout.amountMinor}
                            currency={payout.currency}
                          />
                        ) : null}
                      </TableCell>
                    ) : null}
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
