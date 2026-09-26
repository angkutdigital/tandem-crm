import { cookies } from "next/headers";
import type { TandemAuthAdapter, TandemMemberRow } from "tandem-crm";
import { withTandemSession } from "tandem-crm/db";

import { pool } from "./db";
import { DEFAULT_DEMO_USER_ID } from "./demo-users";
import { getHostUserId } from "./host-auth";

const SESSION_COOKIE = "tandem_demo_user";

/** Demo remains the zero-config reference experience. A deployed dashboard
 * must explicitly opt into host mode, where host-auth.ts is the only place
 * identity is resolved. */
export const isDemoAuth = process.env.TANDEM_AUTH_MODE !== "host";

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

function createDashboardAuthAdapter(
  getCurrentUserId: () => Promise<string | null>
): TandemAuthAdapter {
  return {
    getCurrentUserId,
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
}

export const demoAuthAdapter = createDashboardAuthAdapter(async () => {
  const store = await cookies();
  // middleware.ts writes this cookie for the next request. The fallback keeps
  // the very first demo request deterministic as well.
  return store.get(SESSION_COOKIE)?.value ?? DEFAULT_DEMO_USER_ID;
});

export const hostAuthAdapter = createDashboardAuthAdapter(getHostUserId);

/** The adapter every page and action uses. The demo cookie is never read
 * once a deployment deliberately selects host-auth mode. */
export const dashboardAuthAdapter = isDemoAuth ? demoAuthAdapter : hostAuthAdapter;

/** Used only by the reference-demo identity switcher. */
export async function setDemoUser(userId: string): Promise<void> {
  if (!isDemoAuth) throw new Error("demo identity switching is disabled in host auth mode");
  const store = await cookies();
  store.set(SESSION_COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
}
