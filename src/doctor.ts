export type DoctorCheckResult = { name: string; passed: boolean; detail: string };

type PostgrestErrorBody = { code?: string; message?: string };

/**
 * Standalone setup check for a Tandem installation. Uses plain `fetch`
 * (no Supabase SDK) so it can run from anywhere: a CLI, a CI job, or a
 * support engineer's laptop, against a live project from the outside.
 */
export async function runTandemDoctor(
  supabaseUrl: string,
  supabaseKey: string
): Promise<DoctorCheckResult[]> {
  const url = `${supabaseUrl}/rest/v1/workspaces?select=id&limit=1`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Profile": "tandem",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });
  } catch (error) {
    return [
      {
        name: "tandem schema reachable",
        passed: false,
        detail: `Network error contacting ${supabaseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    ];
  }

  let body: PostgrestErrorBody | unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const errorBody = (body ?? {}) as PostgrestErrorBody;
  const code = errorBody.code;

  // Schema not exposed to PostgREST at all.
  if (response.status === 406 || code === "PGRST106") {
    return [
      {
        name: "tandem schema exposed to PostgREST",
        passed: false,
        detail:
          "The `tandem` schema is not exposed to PostgREST. Add `tandem` to the " +
          "project's exposed schemas in Supabase Settings → API, then retry.",
      },
    ];
  }

  // Schema IS exposed, but this key has no grant: the expected outcome for
  // a public/anon key with no session. Only `authenticated` should have grants.
  if (response.status === 401 || code === "42501") {
    return [
      {
        name: "tandem schema exposed to PostgREST",
        passed: true,
        detail: "The `tandem` schema is exposed (PostgREST reached it).",
      },
      {
        name: "anon key correctly has no direct access",
        passed: true,
        detail:
          "The supplied key was rejected by the schema's grants, which is the " +
          "expected outcome for a public key with no session.",
      },
    ];
  }

  if (response.ok) {
    return [
      {
        name: "tandem schema reachable",
        passed: true,
        detail: `Received HTTP ${response.status} from the tandem schema.`,
      },
    ];
  }

  return [
    {
      name: "tandem schema reachable",
      passed: false,
      detail: `Unexpected response: HTTP ${response.status}${
        errorBody.message ? `: ${errorBody.message}` : ""
      }`,
    },
  ];
}
