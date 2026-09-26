import Link from "next/link";
import { BadgeCheck, ListChecks, Trophy, Users, Wallet, type LucideIcon } from "lucide-react";

import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  getAgentDetail,
  getAgentSummaries,
  getOnboardingSteps,
  getPendingPayoutsSummary,
  getPipelineCounts,
  isAgentCurrentlyCertified,
  requireCurrentMember,
  type AgentSummary,
} from "@/lib/queries";

const PIPELINE_STATUSES = [
  "Automated_Setup",
  "Manual_Review",
  "Won",
  "Commission_Hold",
  "Commission_Eligible",
  "Commission_Paid",
  "Lost",
  "Refunded",
] as const;

const CLOSED_STATUSES = new Set<string>(["Commission_Paid", "Lost", "Refunded"]);

const WON_STATUSES = ["Won", "Commission_Hold", "Commission_Eligible"] as const;

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ");
}

function formatCurrency(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amountMinor / 100);
}

function initialsOf(name: string) {
  return name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <Icon className="size-3.5 text-muted-foreground" />
          {label}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold tracking-tight tabular-nums">
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function AgentStatusBadge({ agent }: { agent: AgentSummary }) {
  if (isAgentCurrentlyCertified(agent)) return <Badge>Certified</Badge>;
  if (agent.certifiedAt) return <Badge variant="destructive">Needs review</Badge>;
  if (agent.startedAt) return <Badge variant="secondary">In progress</Badge>;
  return <Badge variant="outline">Not started</Badge>;
}

export default async function OverviewPage() {
  const member = await requireCurrentMember();
  const isManager = member.role === "owner" || member.role === "admin";

  // tandem.leads/payouts RLS already scopes these to "my own" for an agent
  // and to the whole workspace for owner/admin, so these two queries need
  // no role branching. The workspace-wide agent roster is different: an
  // agent can see every agents row but only their OWN onboarding_status row
  // (by design, in migration 008's RLS), so mixing the two for a non-manager
  // would show co-workers' real certification state as a false "not
  // started". Managers get that roster; agents get their own checklist.
  const [counts, payouts, agents, myOnboarding] = await Promise.all([
    getPipelineCounts(member.userId),
    getPendingPayoutsSummary(member.userId),
    isManager ? getAgentSummaries(member.userId) : Promise.resolve(null),
    !isManager
      ? Promise.all([
          getOnboardingSteps(member.userId),
          member.agentId ? getAgentDetail(member.userId, member.agentId) : null,
        ])
      : Promise.resolve(null),
  ]);

  const openLeads = Object.entries(counts)
    .filter(([status]) => !CLOSED_STATUSES.has(status))
    .reduce((total, [, count]) => total + count, 0);

  const wonThisCycle = WON_STATUSES.reduce(
    (total, status) => total + (counts[status] ?? 0),
    0
  );

  const certifiedAgents = agents?.filter(isAgentCurrentlyCertified).length ?? 0;
  const [onboardingSteps, myAgentDetail] = myOnboarding ?? [[], null];
  const myRequiredSteps = onboardingSteps.filter((step) => step.required);
  const myCompletedRequired = myAgentDetail
    ? myRequiredSteps.filter((step) => myAgentDetail.completedStepCodes.includes(step.code)).length
    : 0;
  const myCertificationCurrent = myAgentDetail !== null
    && myAgentDetail.certifiedAt !== null
    && myCompletedRequired === myRequiredSteps.length;

  const peakPipelineCount = Math.max(
    1,
    ...PIPELINE_STATUSES.map((status) => counts[status] ?? 0)
  );

  const payoutValue = payouts.currency
    ? formatCurrency(payouts.totalMinor, payouts.currency)
    : String(payouts.count);
  const payoutHint =
    payouts.count === 0
      ? "Nothing held or eligible right now"
      : `${payouts.count} payout${payouts.count === 1 ? "" : "s"} held or eligible`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
      </header>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Users}
          label="Open leads"
          value={openLeads.toLocaleString()}
          hint="Excludes paid, lost, and refunded"
        />
        <StatTile
          icon={Trophy}
          label="Won this cycle"
          value={wonThisCycle.toLocaleString()}
          hint="Won, in hold, or commission-eligible"
        />
        <StatTile
          icon={Wallet}
          label="Pending payouts"
          value={payoutValue}
          hint={payoutHint}
        />
        {isManager ? (
          <StatTile
            icon={BadgeCheck}
            label="Certified agents"
            value={`${certifiedAgents} / ${agents?.length ?? 0}`}
            hint="Completed every required onboarding step"
          />
        ) : (
          <StatTile
            icon={ListChecks}
            label="Your onboarding"
            value={
              myCertificationCurrent
                ? "Certified"
                : `${myCompletedRequired} / ${myRequiredSteps.length}`
            }
            hint={
              myCertificationCurrent
                ? "All required steps complete"
                : "Required steps completed"
            }
          />
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>Leads by pipeline status.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {PIPELINE_STATUSES.map((status) => {
              const value = counts[status] ?? 0;
              return (
                <div key={status} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-sm font-medium">
                      {humanizeStatus(status)}
                    </span>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {value}
                    </span>
                  </div>
                  <Progress
                    value={(value / peakPipelineCount) * 100}
                    className="h-1.5"
                  />
                </div>
              );
            })}
          </CardContent>
        </Card>

        {isManager ? (
          <Card>
            <CardHeader>
              <CardTitle>Agents</CardTitle>
              <CardDescription>
                Onboarding progress and current workload.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {!agents || agents.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No agents in this workspace yet.
                </p>
              ) : (
                agents.map((agent) => {
                  const stepLabel =
                    agent.requiredStepCount > 0
                      ? `${agent.completedStepCount}/${agent.requiredStepCount} steps`
                      : null;
                  const meta = [
                    `${agent.openLeadCount} open lead${
                      agent.openLeadCount === 1 ? "" : "s"
                    }`,
                    stepLabel,
                  ]
                    .filter(Boolean)
                    .join(" · ");

                  return (
                    <Link
                      key={agent.id}
                      href={`/agents/${agent.id}`}
                      className="-mx-2 flex items-center justify-between gap-4 rounded-md px-2 py-2 transition-colors hover:bg-muted/60"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar className="size-8">
                          <AvatarFallback className="text-xs font-medium">
                            {initialsOf(agent.displayName) || "?"}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {agent.displayName}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {meta}
                          </p>
                        </div>
                      </div>
                      <AgentStatusBadge agent={agent} />
                    </Link>
                  );
                })
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Your onboarding</CardTitle>
              <CardDescription>
                Complete every required step, then certify yourself.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {myAgentDetail ? (
                <OnboardingChecklist
                  agentId={myAgentDetail.id}
                  steps={onboardingSteps}
                  completedStepCodes={myAgentDetail.completedStepCodes}
                  startedAt={myAgentDetail.startedAt}
                  certifiedAt={myAgentDetail.certifiedAt}
                  certificationCurrent={myCertificationCurrent}
                />
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No agent profile is linked to your account yet.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
