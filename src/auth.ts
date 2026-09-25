import type { TandemAuthAdapter, TandemMemberRow } from "./authAdapter";

export type TandemMember = TandemMemberRow; // keep existing shape/name for callers

/**
 * The signed-in user's Tandem membership in a specific workspace, or null
 * if not signed in or not a member of that workspace. Tandem has no
 * concept yet of "the current workspace" resolved from session/subdomain —
 * callers pass workspaceId explicitly (from the route).
 */
export async function getCurrentTandemMember(
  adapter: TandemAuthAdapter,
  workspaceId: string
): Promise<TandemMember | null> {
  try {
    const userId = await adapter.getCurrentUserId();
    if (!userId) return null;
    return await adapter.getMember(workspaceId, userId);
  } catch {
    return null;
  }
}

/** true if the current user is an owner or admin of workspaceId. */
export async function isCurrentUserTandemAdmin(
  adapter: TandemAuthAdapter,
  workspaceId: string
): Promise<boolean> {
  const member = await getCurrentTandemMember(adapter, workspaceId);
  return member?.role === "owner" || member?.role === "admin";
}

/**
 * The signed-in user's own membership row, without knowing the workspace
 * in advance — used right after login to find where to send them. A user
 * is expected to belong to exactly one workspace in this MVP; if they
 * somehow belong to more than one, return the first one found (order is
 * whatever the DB returns — good enough for now, this is a single-
 * workspace-per-user product today). A real "pick a workspace" UI would
 * be needed if that assumption ever breaks.
 */
export async function getAnyCurrentTandemMembership(
  adapter: TandemAuthAdapter
): Promise<TandemMember | null> {
  try {
    const userId = await adapter.getCurrentUserId();
    if (!userId) return null;
    return await adapter.getAnyMember(userId);
  } catch {
    return null;
  }
}
