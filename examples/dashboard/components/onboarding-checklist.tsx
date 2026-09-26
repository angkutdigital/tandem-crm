"use client";

import { useTransition } from "react";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

import { certifyAgent, completeOnboardingStep } from "@/lib/actions";
import type { OnboardingStep } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function OnboardingChecklist({
  agentId,
  steps,
  completedStepCodes,
  startedAt,
  certifiedAt,
  certificationCurrent,
}: {
  agentId: string;
  steps: OnboardingStep[];
  completedStepCodes: string[];
  startedAt: string | null;
  certifiedAt: string | null;
  certificationCurrent: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const completed = new Set(completedStepCodes);
  const requiredSteps = steps.filter((step) => step.required);
  const allRequiredDone = requiredSteps.every((step) => completed.has(step.code));

  function toggleStep(step: OnboardingStep) {
    if (completed.has(step.code) || isPending) return;
    startTransition(async () => {
      await completeOnboardingStep(agentId, step.code, startedAt != null);
    });
  }

  function handleCertify() {
    startTransition(async () => {
      await certifyAgent(agentId);
    });
  }

  if (certifiedAt && certificationCurrent) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <CheckCircle2 className="size-8 text-primary" />
        <p className="text-sm font-medium">You are certified</p>
        <p className="text-xs text-muted-foreground">
          Certified on {new Date(certifiedAt).toLocaleDateString()}
        </p>
      </div>
    );
  }

  if (certifiedAt) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Circle className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">Certification needs review</p>
        <p className="text-xs text-muted-foreground">
          Your workspace added a required step. An owner or admin must reopen certification before you can complete it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {steps.map((step) => {
        const done = completed.has(step.code);
        return (
          <button
            key={step.code}
            type="button"
            disabled={done || isPending}
            onClick={() => toggleStep(step)}
            className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-default"
          >
            {done ? (
              <CheckCircle2 className="size-4 shrink-0 text-primary" />
            ) : (
              <Circle className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span
              className={`flex-1 text-sm ${done ? "text-muted-foreground line-through" : ""}`}
            >
              {step.label}
            </span>
            {step.required && !done ? (
              <Badge variant="outline" className="text-[10px]">
                Required
              </Badge>
            ) : null}
          </button>
        );
      })}

      <Button
        className="mt-3 self-start"
        size="sm"
        disabled={!allRequiredDone || isPending}
        onClick={handleCertify}
      >
        {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
        Mark myself certified
      </Button>
    </div>
  );
}
