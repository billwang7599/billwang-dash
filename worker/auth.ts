import { createRemoteJWKSet, jwtVerify } from "jose";

/** Verifies the Access JWT that the edge injects on protected routes. */

export interface AuthedUser {
  /** Stable per-user key, used verbatim as the Durable Object name. */
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuer: string) {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

/** DEV_USER applies only when ACCESS_TEAM_DOMAIN is unset (local dev, tests). */
export async function getUser(request: Request, env: Env): Promise<AuthedUser | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();

  if (!teamDomain) {
    const devUser = env.DEV_USER?.trim();
    if (!devUser) return null;
    return {
      id: `dev:${devUser}`,
      email: devUser,
      name: "Dev User",
      isAdmin: isAdmin(env, devUser, []),
    };
  }

  // The cookie is the fallback for paths Access does not cover, like "/".
  const token =
    request.headers.get("cf-access-jwt-assertion") ??
    getCookie(request, "CF_Authorization");
  if (!token) return null;

  const issuer = /^https?:\/\//.test(teamDomain)
    ? teamDomain.replace(/\/+$/, "")
    : `https://${teamDomain.replace(/\/+$/, "")}`;

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, getJwks(issuer), {
      issuer,
      audience: env.ACCESS_AUD,
    }));
  } catch (err) {
    console.warn("auth: JWT verification failed", {
      issuer,
      expectedAud: env.ACCESS_AUD,
      reason: (err as Error).message,
    });
    return null;
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  // `sub` is stable; email can change at the IdP and would orphan the DO.
  const id = (typeof payload.sub === "string" && payload.sub) || email;
  if (!id || !email) {
    console.warn("auth: token verified but missing sub/email", Object.keys(payload));
    return null;
  }

  const groups = Array.isArray(payload.groups)
    ? payload.groups.filter((g): g is string => typeof g === "string")
    : [];

  return {
    id,
    email,
    name: typeof payload.name === "string" ? payload.name : null,
    isAdmin: isAdmin(env, email, groups),
  };
}

function isAdmin(env: Env, email: string, groups: string[]): boolean {
  const list = (raw: string | undefined) =>
    (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  return (
    list(env.ADMIN_EMAILS).includes(email.toLowerCase()) ||
    groups.some((g) => list(env.ADMIN_GROUPS).includes(g.toLowerCase()))
  );
}

function getCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
