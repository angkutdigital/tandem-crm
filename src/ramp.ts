import { eventIdempotencyKey } from "./domain.js";

export type OnboardingStepDefinition = {
  code: string;
  label: string;
  required: boolean;
};

type AgentOnboardingEventBase = {
  id: string;
  sequence: number;
  workspaceId: string;
  agentId: string;
  source: string;
  sourceEventId: string;
  occurredAt: string;
};

export type AgentOnboardingEvent = AgentOnboardingEventBase & (
  | { type: "onboarding.started"; data: Record<string, never> }
  | { type: "onboarding.step_completed"; data: { stepCode: string } }
  | { type: "onboarding.certified"; data: Record<string, never> }
  | { type: "onboarding.reopened"; data: Record<string, never> }
);

export type AgentOnboardingState = {
  workspaceId: string;
  agentId: string;
  startedAt: string | null;
  completedStepCodes: readonly string[];
  certifiedAt: string | null;
  lastSequence: number;
};

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(parsed)) {
    throw new Error("timestamp must be an ISO 8601 instant");
  }
  return parsed;
}

/** domain.ts does not export its canonicalizer; same rules keep duplicate-id fingerprints stable. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function requireTransition(condition: unknown, type: string): asserts condition {
  if (!condition) throw new Error(`invalid transition: ${type}`);
}
function currentState(state: AgentOnboardingState | null): AgentOnboardingState {
  if (state === null) throw new Error("onboarding has not started");
  return state;
}

/** Rebuild one agent's onboarding state in append order, ignoring exact delivery retries. */
export function replayAgentOnboardingEvents(events: readonly AgentOnboardingEvent[], workspaceId: string, agentId: string): AgentOnboardingState | null {
  const seenIds = new Map<string, string>();
  const seenSources = new Map<string, string>();
  let state: AgentOnboardingState | null = null;
  let lastSequence = 0;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.workspaceId !== workspaceId || event.agentId !== agentId) throw new Error("event belongs to another agent or workspace");
    if (!event.id.trim() || !Number.isSafeInteger(event.sequence) || event.sequence <= 0) throw new Error("event id and positive sequence are required");
    instant(event.occurredAt);
    const sourceKey = eventIdempotencyKey(event.source, event.sourceEventId);
    const fingerprint = canonical(event);
    const prior = seenIds.get(event.id);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error("conflicting duplicate event id");
      continue;
    }
    if (seenSources.has(sourceKey)) throw new Error("conflicting duplicate source event id");
    if (event.sequence <= lastSequence) throw new Error("duplicate or out-of-order event sequence");
    seenIds.set(event.id, fingerprint);
    seenSources.set(sourceKey, event.id);
    lastSequence = event.sequence;
    switch (event.type) {
      case "onboarding.started":
        requireTransition(state === null, event.type);
        state = { workspaceId, agentId, startedAt: event.occurredAt, completedStepCodes: [], certifiedAt: null, lastSequence };
        break;
      case "onboarding.step_completed":
        requireTransition(state !== null && state.certifiedAt === null, event.type);
        if (!event.data.stepCode.trim()) throw new Error("stepCode is required");
        state = {
          ...currentState(state),
          completedStepCodes: currentState(state).completedStepCodes.includes(event.data.stepCode)
            ? currentState(state).completedStepCodes
            : [...currentState(state).completedStepCodes, event.data.stepCode],
          lastSequence,
        };
        break;
      case "onboarding.certified":
        requireTransition(state !== null && state.certifiedAt === null, event.type);
        state = { ...currentState(state), certifiedAt: event.occurredAt, lastSequence };
        break;
      case "onboarding.reopened":
        // A required-step template is mutable. Reopening preserves every
        // completed step and the immutable prior certification event while
        // making the agent eligible to complete a newly-required step and
        // certify again. The database limits this event to workspace admins.
        requireTransition(state !== null && state.certifiedAt !== null, event.type);
        state = { ...currentState(state), certifiedAt: null, lastSequence };
        break;
      default:
        throw new Error(`unsupported event type: ${(event as { type: string }).type}`);
    }
  }
  return state;
}

export function isAgentCertified(state: AgentOnboardingState | null, requiredStepCodes: readonly string[]): boolean {
  if (state === null || state.certifiedAt === null) return false;
  const completed = state.completedStepCodes;
  // certifiedAt alone is trusted, but the required steps are also checked against the
  // completed list, so a caller can pass the workspace's current required-step list and
  // still get a real answer when that list changed after certification.
  return requiredStepCodes.every((code) => completed.includes(code));
}
