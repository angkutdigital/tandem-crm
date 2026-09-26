import { getRoutingStrategy, requireCurrentMember } from "@/lib/queries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RoutingStrategyForm } from "@/components/routing-strategy-form";

export default async function RoutingSettingsPage() {
  const member = await requireCurrentMember();

  // Routing policy is an owner-level decision, not something an agent or
  // partner should even see, let alone change -- unlike Payouts/Leads,
  // there's no read-only view for anyone else here.
  if (member.role !== "owner") {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Only the workspace owner can view routing settings.
          </CardContent>
        </Card>
      </div>
    );
  }

  const strategy = await getRoutingStrategy(member.userId);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Routing</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Lead routing strategy</CardTitle>
          <CardDescription>
            New leads are assigned to an agent automatically according to this strategy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RoutingStrategyForm currentStrategy={strategy} />
        </CardContent>
      </Card>
    </div>
  );
}
