import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_DEMO_USER_ID } from "./lib/demo-users";

const SESSION_COOKIE = "tandem_demo_user";

/** Sets a default demo identity for the browser's *next* request. (This
 * request's own Server Components still see the cookie jar as it arrived,
 * so lib/auth.ts's getCurrentUserId() carries the same default as a
 * same-request fallback -- see the comment there.) */
export function middleware(request: NextRequest) {
  // A production host owns sign-in/session protection in its own middleware.
  // Never manufacture a demo identity when host-auth mode is explicit.
  if (process.env.TANDEM_AUTH_MODE === "host") return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const response = NextResponse.next();
  response.cookies.set(SESSION_COOKIE, DEFAULT_DEMO_USER_ID, { httpOnly: true, sameSite: "lax", path: "/" });
  return response;
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
