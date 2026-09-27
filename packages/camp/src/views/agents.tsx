import Link from "next/link";

import { Badge } from "../components/ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { getAgentSummaries, isAgentCurrentlyCertified, requireCurrentMember, type AgentSummary } from "../queries.js";

function statusFor(agent: AgentSummary) {
  if (isAgentCurrentlyCertified(agent)) return { label: "Certified", variant: "default" as const };
  if (agent.certifiedAt) return { label: "Needs review", variant: "destructive" as const };
  if (agent.startedAt) return { label: "In progress", variant: "secondary" as const };
  return { label: "Not started", variant: "outline" as const };
}

/**
 * Camp's Agents view. Roster (read-only) only for this pass -- agent
 * creation ("Add agent") isn't migrated, since it needs Dialog/Input UI
 * primitives this package doesn't have yet. The per-agent "you are an
 * agent, here is your own roster redirect" branch the reference dashboard
 * has also isn't ported: Camp's Overview is manager-only today (see
 * views/overview.tsx), so this view is too, for the same reason.
 */
export async function AgentsView({ basePath }: { basePath: string }) {
  const member = await requireCurrentMember();
  const agents = await getAgentSummaries(member.userId);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="text-sm text-muted-foreground">Onboarding status, lead workload, and certification across this workspace.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Team roster</CardTitle>
          <CardDescription>{agents.length} active agent{agents.length === 1 ? "" : "s"} in this workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No agents yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Onboarding</TableHead>
                  <TableHead>Open leads</TableHead>
                  <TableHead className="text-right">Profile</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => {
                  const status = statusFor(agent);
                  return (
                    <TableRow key={agent.id}>
                      <TableCell className="font-medium">{agent.displayName}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={status.variant}>{status.label}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {agent.completedStepCount}/{agent.requiredStepCount} required steps
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums">{agent.openLeadCount}</TableCell>
                      <TableCell className="text-right">
                        <Link href={`${basePath}/${agent.id}`} className="text-sm font-medium text-primary hover:underline">
                          View
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
