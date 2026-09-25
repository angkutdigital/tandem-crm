import { describe, expect, it } from "vitest";
import type { TandemAdminAdapter, TandemAuthAdapter, TandemMemberRow } from "./authAdapter";
import {
  getAnyCurrentTandemMembership,
  getCurrentTandemMember,
  isCurrentUserTandemAdmin,
} from "./auth";

type FakeAdapterOptions = {
  userId?: string | null;
  member?: TandemMemberRow | null;
  anyMember?: TandemMemberRow | null;
  error?: unknown;
};

function fakeAdapter({
  userId = "user-1",
  member = null,
  anyMember = null,
  error = null,
}: FakeAdapterOptions = {}): TandemAuthAdapter {
  return {
    getCurrentUserId: async () => userId,
    getMember: async () => {
      if (error) throw error;
      return member;
    },
    getAnyMember: async () => {
      if (error) throw error;
      return anyMember;
    },
  };
}

const agentRow: TandemMemberRow = {
  id: "member-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "agent",
  agentId: "agent-1",
};

describe("getCurrentTandemMember", () => {
  it("returns null when there is no session", async () => {
    await expect(
      getCurrentTandemMember(fakeAdapter({ userId: null }), "ws-1")
    ).resolves.toBeNull();
  });

  it("returns null when there is no matching row", async () => {
    await expect(
      getCurrentTandemMember(fakeAdapter({ member: null }), "ws-1")
    ).resolves.toBeNull();
  });

  it("maps an agent row to a TandemMember", async () => {
    await expect(
      getCurrentTandemMember(fakeAdapter({ member: agentRow }), "ws-1")
    ).resolves.toEqual(agentRow);
  });

  it("returns null on a real query error rather than throwing", async () => {
    await expect(
      getCurrentTandemMember(fakeAdapter({ error: new Error("boom") }), "ws-1")
    ).resolves.toBeNull();
  });
});

describe("isCurrentUserTandemAdmin", () => {
  it("is true for an owner", async () => {
    await expect(
      isCurrentUserTandemAdmin(
        fakeAdapter({ member: { ...agentRow, role: "owner", agentId: null } }),
        "ws-1"
      )
    ).resolves.toBe(true);
  });

  it("is false for an agent", async () => {
    await expect(
      isCurrentUserTandemAdmin(fakeAdapter({ member: agentRow }), "ws-1")
    ).resolves.toBe(false);
  });
});

describe("getAnyCurrentTandemMembership", () => {
  it("returns null when there is no session", async () => {
    await expect(
      getAnyCurrentTandemMembership(fakeAdapter({ userId: null }))
    ).resolves.toBeNull();
  });

  it("returns the first membership row found", async () => {
    const adminRow: TandemMemberRow = { ...agentRow, role: "admin", agentId: null };
    await expect(
      getAnyCurrentTandemMembership(fakeAdapter({ anyMember: adminRow }))
    ).resolves.toEqual(adminRow);
  });
});

describe("TandemAdminAdapter", () => {
  it("createMembership is callable with the documented shape", async () => {
    const adminAdapter: TandemAdminAdapter = {
      createMembership: async (workspaceId, userId, role, agentId) => ({
        id: "member-1",
        workspaceId,
        userId,
        role,
        agentId,
      }),
    };

    await expect(
      adminAdapter.createMembership("ws-1", "user-1", "agent", "agent-1")
    ).resolves.toEqual(agentRow);
  });
});
