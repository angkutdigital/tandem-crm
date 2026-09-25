import { cookies } from "next/headers";
import type { TandemAuthAdapter, TandemMemberRow } from "tandem-crm";
import { pool } from "./db";
import { withTandemSession } from "tandem-crm/db";
import { DEFAULT_DEMO_USER_ID } from "./demo-users";

const SESSION_COOKIE = "tandem_demo_user";

/**
 * Reference TandemAuthAdapter implementation. This example has no real
 * identity provider: "signing in" is a demo user switcher (see
 * components/user-switcher.tsx) that sets this cookie directly. It's still a
 * genuine adapter, implementing the same three methods any real one would
 * against Supabase Auth, Clerk, or a hand-rolled session table.
 *
 * getCurrentUserId runs on the plain pool: resolving *which* user is calling
 * is a prerequisite for scoping a session to them, not something that can
 * itself be scoped by an identity we don't have yet. getMember/getAnyMember
 * are different: they already have a userId, so they scope a real
 * withTandemSession to it, same as everything else, and rely on
 * tandem.members' own "read your own row" RLS policy rather than any
 * elevated access.
 */
export const demoAuthAdapter: TandemAuthAdapter = {
  async getCurrentUserId() {
    const store = await cookies();
    // middleware.ts sets this cookie for the browser's next request, but a
    // request's own Server Components still see the cookie jar as it was
    // when the request arrived, so the very first request (no cookie yet)
    // falls back to the same default identity middleware would have set.
    return store.get(SESSION_COOKIE)?.value ?? DEFAULT_DEMO_USER_ID;
  },

  async getMember(workspaceId, userId) {
    const row = await withTandemSession(pool, userId, (client) =>
      client.query<MemberRow>(
        `select id, workspace_id, user_id, role, agent_id
         from tandem.members
         where workspace_id = $1 and user_id = $2`,
        [workspaceId, userId]
      )
    );
    return toMemberRow(row.rows[0]);
  },

  async getAnyMember(userId) {
    const row = await withTandemSession(pool, userId, (client) =>
      client.query<MemberRow>(
        `select id, workspace_id, user_id, role, agent_id
         from tandem.members
         where user_id = $1
         limit 1`,
        [userId]
      )
    );
    return toMemberRow(row.rows[0]);
  },
};

export async function setDemoUser(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
}

type MemberRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: "owner" | "admin" | "agent";
  agent_id: string | null;
};

function toMemberRow(row: MemberRow | undefined): TandemMemberRow | null {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    agentId: row.agent_id,
  };
}
