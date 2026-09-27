import { AddCommissionRuleForm, AddOnboardingStepForm, AddTerritoryForm, LinkExistingUserForm } from "../components/workspace-setup-forms.js";
import { Badge } from "../components/ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { getAgentSummaries, getCommissionRules, getOnboardingSteps, getTerritories, requireCurrentMember } from "../queries.js";

/**
 * Camp's Workspace setup view: onboarding requirements, routing
 * territories, commission policy, and linking a host-authenticated user
 * to an agent profile. Mirrors examples/dashboard's own workspace setup
 * page; the dashboard's isDemoAuth-only branch on the last section is not
 * ported since Camp has no equivalent concept -- a real host always has a
 * real auth provider to link against.
 */
export async function SettingsSetupView() {
  const member = await requireCurrentMember();
  if (member.role !== "owner" && member.role !== "admin") {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Only a workspace owner or admin can manage workspace setup.</CardContent></Card>
      </div>
    );
  }

  const [steps, territories, commissionRules, agents] = await Promise.all([
    getOnboardingSteps(member.userId),
    getTerritories(member.userId),
    getCommissionRules(member.userId),
    getAgentSummaries(member.userId),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Workspace setup</h1>
        <p className="text-sm text-muted-foreground">Define the operating rules that make onboarding and automatic routing usable.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Onboarding requirements</CardTitle>
          <CardDescription>Required steps determine whether an agent is currently certified. Changing requirements never erases prior history.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <AddOnboardingStepForm />
          {steps.length === 0 ? <p className="text-sm text-muted-foreground">No onboarding steps configured.</p> : (
            <div className="flex flex-wrap gap-2">
              {steps.map((step) => <Badge key={step.code} variant={step.required ? "default" : "outline"}>{step.label}{step.required ? " · required" : " · optional"}</Badge>)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Routing territories</CardTitle>
          <CardDescription>Territories define the pool of agents eligible for automatic lead routing. Add agent coverage next in the agent profile workflow.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <AddTerritoryForm />
          {territories.length === 0 ? <p className="text-sm text-muted-foreground">No territories configured. Automatic routing will have no eligible pool until one is added and agents are assigned to it.</p> : (
            <div className="flex flex-wrap gap-2">
              {territories.map((territory) => <Badge key={territory.id} variant={territory.active ? "secondary" : "outline"}>{territory.name} · {territory.code} · {territory.agentCount} agents</Badge>)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Commission policy</CardTitle>
          <CardDescription>Set the rate and hold period for each product and currency. These rules are configuration for your lead adapter; adding one never retroactively changes an existing payout.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <AddCommissionRuleForm />
          {commissionRules.length === 0 ? <p className="text-sm text-muted-foreground">No commission policy configured.</p> : (
            <div className="flex flex-wrap gap-2">
              {commissionRules.map((rule) => <Badge key={rule.id} variant={rule.active ? "secondary" : "outline"}>{rule.productTag} · {rule.currency} · {(rule.basisPoints / 100).toFixed(2)}% · {rule.holdDays} day hold</Badge>)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Team access</CardTitle>
          <CardDescription>Link an account your own auth system has already created to an agent profile. Tandem does not create logins, store passwords, or choose an auth provider.</CardDescription>
        </CardHeader>
        <CardContent>
          <LinkExistingUserForm agents={agents.map((agent) => ({ id: agent.id, displayName: agent.displayName }))} />
        </CardContent>
      </Card>
    </div>
  );
}
