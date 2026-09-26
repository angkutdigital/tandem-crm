import Link from "next/link";
import { redirect } from "next/navigation";

import { AddAgentDialog } from "@/components/add-agent-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAgentSummaries, isAgentCurrentlyCertified, requireCurrentMember, type AgentSummary } from "@/lib/queries";

function statusFor(agent: AgentSummary) {
  if (isAgentCurrentlyCertified(agent)) return { label: "Certified", variant: "default" as const };
  if (agent.certifiedAt) return { label: "Needs review", variant: "destructive" as const };
  if (agent.startedAt) return { label: "In progress", variant: "secondary" as const };
  return { label: "Not started", variant: "outline" as const };
}

export default async function AgentsPage() {
  const member = await requireCurrentMember();

  // Agents have a useful self-service page, but do not see a misleading
  // workspace roster: Ramp's RLS deliberately hides colleagues' onboarding
  // state from them. Owners/admins get the real operational roster below.
  if (member.role === "agent") {
    if (member.agentId) redirect(`/agents/${member.agentId}`);
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Your membership is not linked to an agent profile yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  const agents = await getAgentSummaries(member.userId);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">Onboarding status, lead workload, and certification across this workspace.</p>
        </div>
        <AddAgentDialog />
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
                        <Link href={`/agents/${agent.id}`} className="text-sm font-medium text-primary hover:underline">
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
