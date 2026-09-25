import { afterEach, describe, expect, it, vi } from "vitest";
import { runTandemDoctor } from "./doctor";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runTandemDoctor", () => {
  it("fails when the schema is not exposed (406 / PGRST106)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(406, {
          code: "PGRST106",
          message: "The schema must be one of the following: public, graphql_public",
        })
      )
    );

    const results = await runTandemDoctor("https://example.supabase.co", "key");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("tandem schema exposed to PostgREST");
    expect(results[0].passed).toBe(false);
    expect(results[0].detail).toContain("exposed schemas");
  });

  it("passes when the schema is exposed but the key has no grant (401 / 42501)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, { code: "42501", message: "permission denied for schema tandem" })
      )
    );

    const results = await runTandemDoctor("https://example.supabase.co", "key");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      name: "tandem schema exposed to PostgREST",
      passed: true,
    });
    expect(results[1]).toMatchObject({
      name: "anon key correctly has no direct access",
      passed: true,
    });
  });

  it("passes when the schema is reachable (2xx)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [])));

    const results = await runTandemDoctor("https://example.supabase.co", "key");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "tandem schema reachable", passed: true });
  });

  it("fails gracefully on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const results = await runTandemDoctor("https://example.supabase.co", "key");
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].detail).toContain("ECONNREFUSED");
  });
});
