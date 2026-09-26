/**
 * Nest's one intentional integration point for production identity.
 *
 * Replace this function with a server-side call to the host application's
 * existing auth system. Examples: Clerk's `auth().userId`, Supabase's
 * `getUser().data.user?.id`, Auth.js's session user id, or the user id from
 * an already-verified session cookie. Return the stable UUID that is stored
 * in `tandem.members.user_id`, or null when signed out.
 *
 * Do not trust a browser-supplied header or query parameter here. This file
 * intentionally throws until a host wires a verified identity source, so
 * production mode fails closed instead of silently becoming the demo owner.
 */
export async function getHostUserId(): Promise<string | null> {
  throw new Error(
    "TANDEM_AUTH_MODE=host requires getHostUserId() in lib/host-auth.ts to be wired to your verified server-side session."
  );
}
