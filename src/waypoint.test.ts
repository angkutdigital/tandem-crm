import { describe, expect, it } from "vitest";
import { selectAgentForLead, type WaypointCandidate } from "./index.js";

const candidates: WaypointCandidate[] = [
  { agentId: "agent-b", openLeadCount: 3 },
  { agentId: "agent-a", openLeadCount: 1 },
  { agentId: "agent-c", openLeadCount: 1 },
];

describe("Tandem lead routing (Waypoint)", () => {
  it("assigns no one when there are no candidates", () => {
    expect(selectAgentForLead([], "round_robin", null)).toBeNull();
  });
  it("is a no-op under the manual strategy", () => {
    expect(selectAgentForLead(candidates, "manual", null)).toBeNull();
    expect(selectAgentForLead(candidates, "manual", "agent-a")).toBeNull();
  });
  it("least_loaded picks the fewest open leads, tie-broken by agentId regardless of input order", () => {
    expect(selectAgentForLead(candidates, "least_loaded", null)).toBe("agent-a");
    const reordered = [candidates[2], candidates[0], candidates[1]];
    expect(selectAgentForLead(reordered, "least_loaded", null)).toBe("agent-a");
  });
  it("least_loaded rejects a negative or non-integer openLeadCount", () => {
    expect(() => selectAgentForLead([{ agentId: "a", openLeadCount: -1 }], "least_loaded", null)).toThrow(
      "openLeadCount must be a non-negative safe integer"
    );
    expect(() => selectAgentForLead([{ agentId: "a", openLeadCount: 1.5 }], "least_loaded", null)).toThrow(
      "openLeadCount must be a non-negative safe integer"
    );
  });
  it("rejects malformed or duplicate candidates for automatic routing", () => {
    expect(() => selectAgentForLead([{ agentId: "", openLeadCount: 0 }], "round_robin", null)).toThrow("agentId is required");
    expect(() => selectAgentForLead([
      { agentId: "agent-a", openLeadCount: 0 },
      { agentId: "agent-a", openLeadCount: 1 },
    ], "least_loaded", null)).toThrow("unique agentId");
  });
  it("round_robin starts at the first sorted agent when there is no prior assignment", () => {
    expect(selectAgentForLead(candidates, "round_robin", null)).toBe("agent-a");
  });
  it("round_robin advances to the next sorted agent and wraps around", () => {
    expect(selectAgentForLead(candidates, "round_robin", "agent-a")).toBe("agent-b");
    expect(selectAgentForLead(candidates, "round_robin", "agent-b")).toBe("agent-c");
    expect(selectAgentForLead(candidates, "round_robin", "agent-c")).toBe("agent-a");
  });
  it("round_robin restarts from the first agent when the last-assigned agent is no longer eligible", () => {
    expect(selectAgentForLead(candidates, "round_robin", "agent-departed")).toBe("agent-a");
  });
  it("rejects an unsupported strategy", () => {
    expect(() => selectAgentForLead(candidates, "auction" as never, null)).toThrow(
      "unsupported waypoint strategy: auction"
    );
  });
});
