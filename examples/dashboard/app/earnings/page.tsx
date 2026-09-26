import { EarningsDashboard } from "@/components/earnings-dashboard";
import { Card, CardContent } from "@/components/ui/card";
import { getEarningsSummary, getMonthlyMetrics, getPayouts, requireCurrentMember } from "@/lib/queries";

function formatCurrency(amountMinor: number, currency: string | null) {
  if (!currency) return "—";
  return new Intl.NumberFormat("en-MY", { style: "currency", currency }).format(amountMinor / 100);
}

export default async function EarningsPage() {
  const member = await requireCurrentMember();
  const [summary, monthlyMetrics, payouts] = await Promise.all([
    getEarningsSummary(member.userId),
    getMonthlyMetrics(member.userId),
    getPayouts(member.userId),
  ]);
  const paidPayouts = payouts
    .filter((payout) => payout.status === "paid" && payout.paidAt)
    .map((payout) => ({ ...payout, paidAt: payout.paidAt! }));
  const currency = summary.currency;

  const totals: Array<[string, number]> = [
    ["This week", summary.weekMinor],
    ["This month", summary.monthMinor],
    ["This year", summary.yearMinor],
    ["All time", summary.lifetimeMinor],
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
        <p className="text-sm text-muted-foreground">A clear record of commissions that have actually been paid.</p>
      </header>

      <section aria-label="Earnings summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {totals.map(([label, amount]) => (
          <Card key={label} size="sm">
            <CardContent className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">{label}</span>
              <span className="text-2xl font-semibold tracking-tight">{formatCurrency(amount, currency)}</span>
            </CardContent>
          </Card>
        ))}
      </section>

      <EarningsDashboard rows={paidPayouts} monthlyMetrics={monthlyMetrics} />
    </div>
  );
}
