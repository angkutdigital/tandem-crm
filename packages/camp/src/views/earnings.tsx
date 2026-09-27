import { EarningsChart } from "../components/earnings-chart.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { getEarningsSummary, getMonthlyMetrics, getPayouts, requireCurrentMember } from "../queries.js";

function formatCurrency(amountMinor: number, currency: string | null) {
  if (!currency) return "—";
  return new Intl.NumberFormat("en-MY", { style: "currency", currency }).format(amountMinor / 100);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-MY", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Camp's Earnings view: paid-commission totals, a 6-month trend chart, and
 * the underlying paid-payout list. Deliberately simpler than
 * examples/dashboard's own EarningsDashboard -- that one uses a
 * DataGrid/tanstack-table subsystem and a shadcn chart wrapper Camp
 * doesn't carry, so this reuses Camp's existing Table primitive and
 * recharts directly (already a dependency) instead of porting that whole
 * subsystem for one screen. No search/sort/CSV export yet.
 */
export async function EarningsView() {
  const member = await requireCurrentMember();
  const [summary, monthlyMetrics, payouts] = await Promise.all([
    getEarningsSummary(member.userId),
    getMonthlyMetrics(member.userId),
    getPayouts(member.userId),
  ]);
  const paidPayouts = payouts.filter((payout) => payout.status === "paid" && payout.paidAt);
  const currency = summary.currency;

  const totals: Array<[string, number]> = [
    ["This week", summary.weekMinor],
    ["This month", summary.monthMinor],
    ["This year", summary.yearMinor],
    ["All time", summary.lifetimeMinor],
  ];

  const chartData = monthlyMetrics.map((metric) => ({
    month: new Date(`${metric.month}-01T00:00:00`).toLocaleDateString("en-MY", { month: "short" }),
    commissions: metric.commissionsClosedMinor / 100,
  }));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
        <p className="text-sm text-muted-foreground">A clear record of commissions that have actually been paid.</p>
      </header>

      <section aria-label="Earnings summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {totals.map(([label, amount]) => (
          <Card key={label}>
            <CardContent className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">{label}</span>
              <span className="text-2xl font-semibold tracking-tight">{formatCurrency(amount, currency)}</span>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Paid commissions</CardTitle>
          <CardDescription>Commission income closed each month. Held or eligible payouts are not included.</CardDescription>
        </CardHeader>
        <CardContent>
          <EarningsChart data={chartData} currency={currency} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Earnings history</CardTitle>
          <CardDescription>Paid commission records only.</CardDescription>
        </CardHeader>
        <CardContent>
          {paidPayouts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No paid commissions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Paid commission</TableHead>
                  <TableHead>Paid on</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paidPayouts.map((payout) => (
                  <TableRow key={payout.id}>
                    <TableCell className="font-medium">{payout.companyName}</TableCell>
                    <TableCell>{formatCurrency(payout.amountMinor, payout.currency)}</TableCell>
                    <TableCell>{formatDate(payout.paidAt!)}</TableCell>
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
