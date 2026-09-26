import { describe, expect, it } from "vitest";
import { isAgentCertified, replayAgentOnboardingEvents, type AgentOnboardingEvent } from "./index.js";

const startedAt = "2026-01-01T00:00:00.000Z";
function fact(sequence: number, type: AgentOnboardingEvent["type"], data: AgentOnboardingEvent["data"], occurredAt = startedAt): AgentOnboardingEvent {
  return {
    id: `event-${sequence}`, sequence, workspaceId: "workspace-1", agentId: "agent-1",
    source: "test", sourceEventId: `source-${sequence}`, occurredAt, type, data,
  } as AgentOnboardingEvent;
}
function inProgress(): AgentOnboardingEvent[] {
  return [
    fact(1, "onboarding.started", {}),
    fact(2, "onboarding.step_completed", { stepCode: "agreement_signed" }),
    fact(3, "onboarding.step_completed", { stepCode: "product_training" }),
  ];
}
const replay = (events: AgentOnboardingEvent[]) => replayAgentOnboardingEvents(events, "workspace-1", "agent-1");

describe("Tandem Ramp deterministic replay", () => {
  it("replays by database sequence and ignores an exact retry", () => {
    const events = inProgress();
    const result = replay([events[2], events[0], events[1], { ...events[1] }]);
    expect(result).toMatchObject({
      startedAt, completedStepCodes: ["agreement_signed", "product_training"], certifiedAt: null, lastSequence: 3,
    });
  });
  it("does not duplicate a step already marked complete", () => {
    const result = replay([...inProgress(), fact(4, "onboarding.step_completed", { stepCode: "agreement_signed" })]);
    expect(result?.completedStepCodes).toEqual(["agreement_signed", "product_training"]);
  });
  it("rejects conflicting IDs, source IDs, sequences, and cross-agent facts", () => {
    const events = inProgress();
    expect(() => replay([events[0], { ...events[0], occurredAt: "2026-02-01T00:00:00.000Z" } as AgentOnboardingEvent])).toThrow("conflicting duplicate event id");
    expect(() => replay([events[0], { ...events[1], sourceEventId: events[0].sourceEventId }])).toThrow("conflicting duplicate source event id");
    expect(() => replay([events[0], { ...events[1], sequence: 1 }])).toThrow("duplicate or out-of-order event sequence");
    expect(() => replay([{ ...events[0], agentId: "agent-2" }])).toThrow("another agent or workspace");
  });
  it("rejects invalid transitions", () => {
    expect(() => replay([fact(1, "onboarding.step_completed", { stepCode: "agreement_signed" })])).toThrow("invalid transition");
    expect(() => replay([fact(1, "onboarding.started", {}), fact(2, "onboarding.started", {})])).toThrow("invalid transition");
    expect(() => replay([fact(1, "onboarding.started", {}), fact(2, "onboarding.reopened", {})])).toThrow("invalid transition");
    const certified = [...inProgress(), fact(4, "onboarding.certified", {})];
    expect(() => replay([...certified, fact(5, "onboarding.step_completed", { stepCode: "late" })])).toThrow("invalid transition");
    expect(() => replay([...certified, fact(5, "onboarding.certified", {})])).toThrow("invalid transition");
    const reopened = [...certified, fact(5, "onboarding.reopened", {})];
    expect(() => replay([...reopened, fact(6, "onboarding.reopened", {})])).toThrow("invalid transition");
  });
  it("rejects unknown persisted event types during replay", () => {
    const unknown = { ...inProgress()[0], type: "onboarding.reset" } as unknown as AgentOnboardingEvent;
    expect(() => replay([unknown])).toThrow("unsupported event type: onboarding.reset");
  });
  it("returns null for no events", () => {
    expect(replay([])).toBeNull();
  });
});

describe("Tandem Ramp certification", () => {
  const requiredSteps = ["agreement_signed", "product_training"];
  it("is not certified before onboarding starts", () => {
    expect(isAgentCertified(null, requiredSteps)).toBe(false);
  });
  it("is not certified while in progress, even with all steps complete", () => {
    expect(isAgentCertified(replay(inProgress()), requiredSteps)).toBe(false);
  });
  it("is certified once certifiedAt is set and every required step is present", () => {
    const state = replay([...inProgress(), fact(4, "onboarding.certified", {})]);
    expect(isAgentCertified(state, requiredSteps)).toBe(true);
  });
  it("is not certified if a since-added required step was never completed", () => {
    const state = replay([...inProgress(), fact(4, "onboarding.certified", {})]);
    expect(isAgentCertified(state, [...requiredSteps, "shadowed_first_call"])).toBe(false);
  });
  it("can be explicitly reopened after requirements change, without losing completed work", () => {
    const certified = [...inProgress(), fact(4, "onboarding.certified", {})];
    const reopened = replay([...certified, fact(5, "onboarding.reopened", {})]);
    expect(reopened).toMatchObject({ certifiedAt: null, completedStepCodes: requiredSteps, lastSequence: 5 });
    expect(isAgentCertified(reopened, requiredSteps)).toBe(false);

    const recertified = replay([
      ...certified,
      fact(5, "onboarding.reopened", {}),
      fact(6, "onboarding.step_completed", { stepCode: "shadowed_first_call" }),
      fact(7, "onboarding.certified", {}),
    ]);
    expect(isAgentCertified(recertified, [...requiredSteps, "shadowed_first_call"])).toBe(true);
  });
});
