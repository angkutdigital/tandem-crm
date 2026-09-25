import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  getAgentDetail,
  getOnboardingSteps,
  requireCurrentMember,
} from "@/lib/queries";

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ");
}

const statusVariantMap: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Automated_Setup: "outline",
  Manual_Review: "outline",
  Won: "secondary",
  Commission_Hold: "secondary",
  Commission_Eligible: "secondary",
  Commission_Paid: "default",
  Lost: "destructive",
  Refunded: "destructive",
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function AgentDetailPage(props: PageProps<"/agents/[id]">) {
  const { id } = await props.params;
  const member = await requireCurrentMember();
  const [agent, steps] = await Promise.all([
    getAgentDetail(member.userId, id),
    getOnboardingSteps(member.userId),
  ]);

  if (!agent) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Agent not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  const requiredSteps = steps.filter((step) => step.required);
  const completedRequired = requiredSteps.filter((step) =>
    agent.completedStepCodes.includes(step.code)
  ).length;

  const statusBadge = agent.certifiedAt ? (
    <Badge>Certified</Badge>
  ) : agent.startedAt ? (
    <Badge variant="secondary">In progress</Badge>
  ) : (
    <Badge variant="outline">Not started</Badge>
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Back to overview
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{agent.displayName}</h1>
          {statusBadge}
        </div>
        <p className="text-sm text-muted-foreground">
          {agent.certifiedAt
            ? `Certified ${formatDate(agent.certifiedAt)}`
            : agent.startedAt
              ? `Started onboarding ${formatDate(agent.startedAt)}`
              : "Has not started onboarding yet"}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Onboarding progress</CardTitle>
          <CardDescription>
            {completedRequired} / {requiredSteps.length} required steps complete
          </CardDescription>
        </CardHeader>
        <CardContent>
          {steps.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No onboarding steps configured.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {steps.map((step) => {
                const done = agent.completedStepCodes.includes(step.code);
                return (
                  <li
                    key={step.code}
                    className="flex items-center justify-between gap-4 rounded-md border px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{step.label}</span>
                      {step.required && (
                        <span className="text-xs text-muted-foreground">Required</span>
                      )}
                    </div>
                    <Badge variant={done ? "default" : "outline"}>
                      {done ? "Complete" : "Outstanding"}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Leads</CardTitle>
          <CardDescription>Leads assigned to this agent.</CardDescription>
        </CardHeader>
        <CardContent>
          {agent.leads.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No leads assigned yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agent.leads.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell className="font-medium">
                      <Link href={`/leads/${lead.id}`} className="hover:underline">
                        {lead.companyName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariantMap[lead.pipelineStatus] ?? "outline"}>
                        {humanizeStatus(lead.pipelineStatus)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatDate(lead.updatedAt)}</TableCell>
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
