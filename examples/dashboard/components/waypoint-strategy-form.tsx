"use client";

import { useState, useTransition, type ComponentType } from "react";
import { Loader2, Route, Shuffle, Users } from "lucide-react";
import { setWaypointStrategy } from "@/lib/actions";
import type { WaypointStrategy } from "@/lib/queries";
import { Button } from "@/components/ui/button";

const strategyOrder: WaypointStrategy[] = ["round_robin", "least_loaded", "manual"];

const strategyOptions: Record<
  WaypointStrategy,
  {
    label: string;
    description: string;
    icon: ComponentType<{ className?: string }>;
  }
> = {
  round_robin: {
    label: "Round robin",
    description: "Round robin: leads are assigned to agents in turn.",
    icon: Shuffle,
  },
  least_loaded: {
    label: "Least loaded",
    description: "Least loaded: leads go to the agent with the fewest open leads.",
    icon: Users,
  },
  manual: {
    label: "Manual",
    description: "Manual: leads are unassigned until a manager assigns them.",
    icon: Route,
  },
};

export function WaypointStrategyForm({
  currentStrategy,
}: {
  currentStrategy: WaypointStrategy;
}) {
  const [isPending, startTransition] = useTransition();
  const [pendingStrategy, setPendingStrategy] = useState<WaypointStrategy | null>(
    null,
  );

  const activeStrategy =
    isPending && pendingStrategy ? pendingStrategy : currentStrategy;
  const activeOption = strategyOptions[activeStrategy];

  function handleSelect(strategy: WaypointStrategy) {
    if (strategy === activeStrategy || isPending) return;

    setPendingStrategy(strategy);
    startTransition(async () => {
      await setWaypointStrategy(strategy);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        {strategyOrder.map((strategy) => {
          const option = strategyOptions[strategy];
          const Icon = option.icon;
          const isActive = activeStrategy === strategy;
          const isThisPending = isPending && pendingStrategy === strategy;

          return (
            <Button
              key={strategy}
              type="button"
              variant={isActive ? "default" : "outline"}
              disabled={isPending}
              onClick={() => handleSelect(strategy)}
              className="flex-1 justify-center gap-2"
            >
              <Icon className="size-4" />
              {option.label}
              {isThisPending ? <Loader2 className="size-4 animate-spin" /> : null}
            </Button>
          );
        })}
      </div>

      <p className="text-sm text-muted-foreground">{activeOption.description}</p>
    </div>
  );
}
