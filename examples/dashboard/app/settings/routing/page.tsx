import { getRoutingStrategy, requireCurrentMember, type RoutingStrategy } from "@/lib/queries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RoutingStrategyForm } from "@/components/routing-strategy-form";

const strategyDetails: Record<RoutingStrategy, { label: string; description: string }> = {
  round_robin: {
    label: "Round robin",
    description: "Round robin: leads are assigned to agents in turn.",
  },
  least_loaded: {
    label: "Least loaded",
    description: "Least loaded: leads go to the agent with the fewest open leads.",
  },
  manual: {
    label: "Manual",
    description: "Manual: leads are unassigned until a manager assigns them.",
  },
};

export default async function RoutingSettingsPage() {
  const member = await requireCurrentMember();
  const strategy = await getRoutingStrategy(member.userId);
  const isManager = member.role === "owner" || member.role === "admin";
  const selectedStrategy = strategyDetails[strategy];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Routing</h1>
        <p className="text-sm text-muted-foreground">
          Configure how new leads are assigned to your workspace.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Lead routing strategy</CardTitle>
          <CardDescription>
            New leads are assigned to an agent automatically according to this strategy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isManager ? (
            <RoutingStrategyForm currentStrategy={strategy} />
          ) : (
            <div className="flex flex-col gap-2">
              <div className="text-lg font-medium">{selectedStrategy.label}</div>
              <p className="text-sm text-muted-foreground">
                {selectedStrategy.description}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Only workspace owners and admins can change this.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
