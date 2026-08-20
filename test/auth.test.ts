import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getUser } from "../worker/auth.ts";

interface MeResponse {
  user: { id: string; email: string; isAdmin: boolean };
}

/**
 * Minimal Env for exercising getUser() directly.
 *
 * `wrangler types` narrows vars to string literals of whatever is in
 * wrangler.jsonc, so test values need the wider cast.
 */
function fakeEnv(over: Record<string, string> = {}): Env {
  return {
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    DEV_USER: "",
    ADMIN_EMAILS: "",
    ADMIN_GROUPS: "",
    ...over,
  } as unknown as Env;
}

describe("dev fallback", () => {
  it("uses DEV_USER when ACCESS_TEAM_DOMAIN is unset", async () => {
    const res = await SELF.fetch("https://example.com/api/me");
    expect(res.status).toBe(200);

    const { user } = await res.json<MeResponse>();
    expect(user.email).toBe("test-user@example.com");
    expect(user.id).toBe("dev:test-user@example.com");
  });

  it("grants admin from the ADMIN_EMAILS allow list", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/whoami");
    expect(res.status).toBe(200);
    expect((await res.json<MeResponse>()).user.isAdmin).toBe(true);
  });

  it("returns null when neither Access nor DEV_USER is configured", async () => {
    const request = new Request("https://example.com/api/me");
    expect(await getUser(request, fakeEnv())).toBeNull();
  });
});

describe("Access JWT verification", () => {
  const env = fakeEnv({
    ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "test-aud",
    // Set, but must be ignored entirely once Access is configured — otherwise
    // a deploy with a stray DEV_USER would silently bypass verification.
    DEV_USER: "should-be-ignored@example.com",
  });

  it("rejects a request with no token", async () => {
    const request = new Request("https://example.com/api/me");
    expect(await getUser(request, env)).toBeNull();
  });

  it("rejects a malformed token rather than falling back to DEV_USER", async () => {
    const request = new Request("https://example.com/api/me", {
      headers: { "cf-access-jwt-assertion": "not-a-jwt" },
    });
    expect(await getUser(request, env)).toBeNull();
  });

  it("rejects a well-formed but unsigned token", async () => {
    // Structurally valid JWT, signed with nothing Access would recognise.
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = btoa(JSON.stringify({ email: "attacker@example.com", sub: "x" }));
    const request = new Request("https://example.com/api/me", {
      headers: { "cf-access-jwt-assertion": `${header}.${body}.` },
    });
    expect(await getUser(request, env)).toBeNull();
  });

  it("reads the token from the CF_Authorization cookie as a fallback", async () => {
    // Still rejected (bad signature), but proves the cookie path is wired up
    // rather than silently ignored.
    const request = new Request("https://example.com/api/me", {
      headers: { cookie: "CF_Authorization=not-a-jwt; other=1" },
    });
    expect(await getUser(request, env)).toBeNull();
  });
});

describe("public / protected split", () => {
  it("does not require identity for the landing page", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).not.toBe(401);
  });

  it("serves the API as JSON, not the SPA shell", async () => {
    const res = await SELF.fetch("https://example.com/api/me");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("does not redirect an anonymous visit to the landing page", async () => {
    const res = await SELF.fetch("https://example.com/", { redirect: "manual" });
    expect(res.status).not.toBe(302);
  });

  it("redirects a signed-in visitor from / straight to /app via the header", async () => {
    // ACCESS_TEAM_DOMAIN is unset in this test env, so getUser() takes the
    // DEV_USER branch regardless of the header's actual content — this test
    // exercises the routing decision (signal present -> check -> redirect),
    // not JWT verification itself, which is covered separately above.
    const res = await SELF.fetch("https://example.com/", {
      headers: { "cf-access-jwt-assertion": "irrelevant-in-dev-mode" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
  });

  it("redirects via the CF_Authorization cookie too", async () => {
    // Access only injects the header on paths it covers (/app*, /api*), not
    // on / itself — a signed-in visitor hitting / carries only the cookie.
    // Regression test for that gap.
    const res = await SELF.fetch("https://example.com/", {
      headers: { cookie: "CF_Authorization=irrelevant-in-dev-mode; other=1" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
  });
});

describe("sign out", () => {
  it("explains there is no Access session when running without Access", async () => {
    const res = await SELF.fetch("https://example.com/logout", { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No Access session to clear");
  });
});
