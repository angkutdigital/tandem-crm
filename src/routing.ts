export type RoutingStrategy = "round_robin" | "least_loaded" | "manual";

export type RoutingCandidate = {
  agentId: string;
  openLeadCount: number;
};

function compareAgentIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function assertOpenLeadCount(openLeadCount: number): void {
  if (!Number.isSafeInteger(openLeadCount) || openLeadCount < 0) {
    throw new Error("openLeadCount must be a non-negative safe integer");
  }
}

/**
 * Picks the agent a new lead should be routed to, or null when routing is a
 * no-op. Pure: the caller supplies the candidates and the workspace strategy,
 * and appends the lead.assigned event itself.
 */
export function selectAgentForLead(
  candidates: readonly RoutingCandidate[],
  strategy: RoutingStrategy,
  lastAssignedAgentId: string | null,
): string | null {
  if (candidates.length === 0) return null;

  if (strategy === "manual") return null;

  if (strategy === "least_loaded") {
    for (const candidate of candidates) {
      assertOpenLeadCount(candidate.openLeadCount);
    }

    let best = candidates[0];
    for (const candidate of candidates) {
      if (
        candidate.openLeadCount < best.openLeadCount ||
        (candidate.openLeadCount === best.openLeadCount &&
          compareAgentIds(candidate.agentId, best.agentId) < 0)
      ) {
        best = candidate;
      }
    }
    return best.agentId;
  }

  if (strategy === "round_robin") {
    const sorted = [...candidates].sort((a, b) => compareAgentIds(a.agentId, b.agentId));

    if (lastAssignedAgentId === null) return sorted[0].agentId;

    const lastIndex = sorted.findIndex((candidate) => candidate.agentId === lastAssignedAgentId);
    if (lastIndex === -1) return sorted[0].agentId;

    return sorted[(lastIndex + 1) % sorted.length].agentId;
  }

  throw new Error(`unsupported routing strategy: ${strategy}`);
}
