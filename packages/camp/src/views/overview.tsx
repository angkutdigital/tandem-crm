import { BadgeCheck, Trophy, Users, Wallet, type LucideIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "../components/ui/avatar.js";
import { Badge } from "../components/ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Progress } from "../components/ui/progress.js";
import {
  getAgentSummaries,
  getPendingPayoutsSummary,
  getPipelineCounts,
  isAgentCurrentlyCertified,
  requireCurrentMember,
  type AgentSummary,
} from "../queries.js";

const PIPELINE_STATUSES = [
  "Automated_Setup", "Manual_Review", "Won",
  "Commission_Hold", "Commission_Eligible", "Commission_Paid",
  "Lost", "Refunded",
] as const;

const CLOSED_STATUSES = new Set<string>(["Commission_Paid", "Lost", "Refunded"]);
const WON_STATUSES = ["Won", "Commission_Hold", "Commission_Eligible"] as const;

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ");
}

function formatCurrency(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

function initialsOf(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function StatTile({ label, value, hint, icon: Icon }: { label: string; value: string; hint: string; icon: LucideIcon }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <Icon className="size-3.5 text-muted-foreground" />
          {label}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold tracking-tight tabular-nums">{value}</CardTitle>
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

/**
 * Camp's Overview view. Deliberately a simplified subset of
 * examples/dashboard's app/page.tsx for this first migrated slice: shows
 * the manager view (stat tiles, pipeline breakdown, agent roster) only.
 * The reference dashboard's per-agent "your own onboarding checklist"
 * branch is not yet ported -- see packages/camp/README.md's migration
 * status for what's still outstanding.
 */
export async function OverviewView() {
  const member = await requireCurrentMember();

  const [counts, payouts, agents] = await Promise.all([
    getPipelineCounts(member.userId),
    getPendingPayoutsSummary(member.userId),
    getAgentSummaries(member.userId),
  ]);

  const openLeads = Object.entries(counts)
    .filter(([status]) => !CLOSED_STATUSES.has(status))
    .reduce((total, [, count]) => total + count, 0);
  const wonThisCycle = WON_STATUSES.reduce((total, status) => total + (counts[status] ?? 0), 0);
  const certifiedAgents = agents.filter(isAgentCurrentlyCertified).length;
  const peakPipelineCount = Math.max(1, ...PIPELINE_STATUSES.map((status) => counts[status] ?? 0));

  const payoutValue = payouts.currency ? formatCurrency(payouts.totalMinor, payouts.currency) : String(payouts.count);
  const payoutHint = payouts.count === 0 ? "Nothing held or eligible right now" : `${payouts.count} payout${payouts.count === 1 ? "" : "s"} held or eligible`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
      </header>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={Users} label="Open leads" value={openLeads.toLocaleString()} hint="Excludes paid, lost, and refunded" />
        <StatTile icon={Trophy} label="Won this cycle" value={wonThisCycle.toLocaleString()} hint="Won, in hold, or commission-eligible" />
        <StatTile icon={Wallet} label="Pending payouts" value={payoutValue} hint={payoutHint} />
        <StatTile icon={BadgeCheck} label="Certified agents" value={`${certifiedAgents} / ${agents.length}`} hint="Completed every required onboarding step" />
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
                    <span className="text-sm font-medium">{humanizeStatus(status)}</span>
                    <span className="text-sm tabular-nums text-muted-foreground">{value}</span>
                  </div>
                  <Progress value={(value / peakPipelineCount) * 100} className="h-1.5" />
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agents</CardTitle>
            <CardDescription>Onboarding progress and current workload.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {agents.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No agents in this workspace yet.</p>
            ) : (
              agents.map((agent) => {
                const stepLabel = agent.requiredStepCount > 0 ? `${agent.completedStepCount}/${agent.requiredStepCount} steps` : null;
                const meta = [`${agent.openLeadCount} open lead${agent.openLeadCount === 1 ? "" : "s"}`, stepLabel].filter(Boolean).join(" · ");
                return (
                  <div key={agent.id} className="-mx-2 flex items-center justify-between gap-4 rounded-md px-2 py-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar className="size-8">
                        <AvatarFallback className="text-xs font-medium">{initialsOf(agent.displayName) || "?"}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{agent.displayName}</p>
                        <p className="truncate text-xs text-muted-foreground">{meta}</p>
                      </div>
                    </div>
                    <AgentStatusBadge agent={agent} />
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
