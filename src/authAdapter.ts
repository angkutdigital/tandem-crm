export type TandemMemberRow = {
  id: string;
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "agent";
  agentId: string | null;
};

/**
 * What Tandem's auth layer needs from whatever identity/database system
 * hosts it. Implement this once per backend (Supabase, plain Postgres +
 * a different auth provider, etc.) and pass it to the functions in
 * `auth.ts`. Keeps the Tandem package itself free of any vendor SDK.
 */
export type TandemAuthAdapter = {
  /** The current request's signed-in user id, or null if not signed in. */
  getCurrentUserId(): Promise<string | null>;
  /** A specific workspace membership for a user, or null if none. */
  getMember(workspaceId: string, userId: string): Promise<TandemMemberRow | null>;
  /** Any one membership row for a user (used right after login), or null. */
  getAnyMember(userId: string): Promise<TandemMemberRow | null>;
};

export type TandemAdminAdapter = {
  /** Creates the membership row linking an already-existing auth user to a
   * workspace. Does NOT create the auth user itself; the caller is
   * responsible for that (e.g. Supabase Auth's admin inviteUserByEmail, or
   * whatever the host auth provider's equivalent is) and passes the
   * resulting userId in here. */
  createMembership(
    workspaceId: string,
    userId: string,
    role: "owner" | "admin" | "agent",
    agentId: string | null
  ): Promise<TandemMemberRow>;
};
