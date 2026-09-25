/** Matches the workspace owner seeded by scripts/seed.mjs. A real app would
 * redirect to a real sign-in instead of defaulting an identity. Kept in its
 * own module (no other imports) so both middleware.ts (edge runtime) and
 * lib/auth.ts (node runtime, imports pg) can use it without pulling
 * runtime-incompatible code into the other. */
export const DEFAULT_DEMO_USER_ID = "c0000000-0000-0000-0000-000000000001";
