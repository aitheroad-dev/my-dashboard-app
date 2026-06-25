import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppEnv } from "./env";

/**
 * Cloudflare Access verification for a per-fork dashboard.
 *
 * Adapted from a proven single-tenant dashboard verifier, stripped of its
 * app-specific role / page-grant model (each fork is its own tenant).
 * We VERIFY the signed `Cf-Access-Jwt-Assertion` JWT (RS256) against the team
 * JWKS — issuer + audience + signature — and derive the email from the verified
 * claims, NEVER from the spoofable `Cf-Access-Authenticated-User-Email` header.
 * A fork that has not configured CF Access (no team domain / AUD) fails closed.
 */

export type AuthedUser = {
  email: string;
  isOwner: boolean;
  sessionId: string | null;
};

// Neutral placeholder owner — EVERY fork sets its real owner via the
// TENANT_OWNER_EMAIL var at provisioning. Kept generic so the template carries no
// personal data. Lockout-safe: the resolved owner is always added to the
// allow-list so a dropped var can't lock them out.
const DEFAULT_OWNER = "owner@example.com";

// Module-scope JWKS cache, keyed by team domain. jose handles key rotation +
// cooldown internally; reusing the set across requests avoids a certs fetch per call.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJwks(teamDomain: string) {
  let set = jwksCache.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, set);
  }
  return set;
}

function ownerEmail(env: AppEnv): string {
  return (env.TENANT_OWNER_EMAIL || DEFAULT_OWNER).toLowerCase();
}

export function isOwnerEmail(email: string, env: AppEnv): boolean {
  return email.toLowerCase() === ownerEmail(env);
}

function allowList(env: AppEnv): Set<string> {
  const raw = env.ACCESS_ALLOWED_EMAILS || "";
  const emails = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  emails.push(ownerEmail(env)); // owner always allowed (lockout-safe)
  return new Set(emails);
}

async function verifyAccessEmail(request: Request, env: AppEnv): Promise<string> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw unauthorized("missing Cf-Access-Jwt-Assertion (request did not pass Access)");
  }
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (!teamDomain || !audience) {
    throw unauthorized("CF Access is not configured for this fork");
  }
  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      audience,
      issuer: `https://${teamDomain}`,
      algorithms: ["RS256"],
    });
    return String(payload.email ?? "").toLowerCase();
  } catch (e) {
    const code =
      (e as { code?: string })?.code ?? (e as Error)?.message ?? "verify_failed";
    throw unauthorized(`invalid Access token: ${code}`);
  }
}

/**
 * Soft identity for handlers/middleware. Returns the identity ONLY for a
 * positively-verified, allow-listed browser user; returns null otherwise
 * (no token, invalid token, non-allow-listed email). Never throws.
 */
export async function identifyAccessUser(
  request: Request,
  env: AppEnv,
): Promise<{ email: string } | null> {
  if (!request.headers.get("Cf-Access-Jwt-Assertion")) return null;
  let email: string;
  try {
    email = await verifyAccessEmail(request, env);
  } catch {
    return null;
  }
  if (!email || !allowList(env).has(email)) return null;
  return { email };
}

/**
 * Hard auth — verifies the CF Access JWT + allow-list. Throws a 401 Response on
 * any failure (fail-closed). Use to gate write/owner endpoints.
 */
export async function requireUser(
  request: Request,
  env: AppEnv,
): Promise<AuthedUser> {
  const email = await verifyAccessEmail(request, env);
  if (!email) throw unauthorized("verified token carries no email claim");
  if (!allowList(env).has(email)) {
    throw unauthorized(`email ${email} not authorized for this fork`);
  }
  return {
    email,
    isOwner: isOwnerEmail(email, env),
    sessionId: request.headers.get("Cf-Access-Jwt-Assertion"),
  };
}

/**
 * MCP control-plane seam — scoped per-fork bearer. Constant-time compare.
 * Stub gate for P0; widened with real tooling in P3.
 */
export function verifyBearer(request: Request, env: AppEnv): boolean {
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !env.MCP_BEARER) return false;
  const a = m[1];
  const b = env.MCP_BEARER;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function unauthorized(reason: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", reason }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
