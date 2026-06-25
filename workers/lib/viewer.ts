import type { AppEnv } from "./env";
import { identifyAccessUser, isOwnerEmail, unauthorized } from "./auth";

/**
 * Data-endpoint viewer seam (ISC-31.5).
 *
 * Bare `requireUser` is too strict for the productized fork: a fork that has not
 * yet put CF Access in front (the current live workers.dev fork, and ALL local
 * dev) would 401 every page, so nothing renders. `getViewer` resolves identity by
 * the fork's actual posture:
 *
 *   - CF Access CONFIGURED (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` set) → require a
 *     positively-verified, allow-listed Access user; an unverified request → null
 *     (handler returns 401). The gate is fully real where it matters.
 *   - CF Access UNCONFIGURED → owner "open-dev" viewer, so a freshly deployed bare
 *     fork shows its seeded pages and the owner can develop locally. The fork holds
 *     only the recipient's own (seeded/demo) data and is physically isolated (L2);
 *     the recipient adds CF Access to lock it down (ISC-30).
 */

export type ViewerMode = "access" | "open-dev";

export interface Viewer {
  email: string;
  isOwner: boolean;
  mode: ViewerMode;
}

export function accessConfigured(env: AppEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

/** Soft viewer — returns null when an Access-configured fork sees no valid user. */
export async function getViewer(
  request: Request,
  env: AppEnv,
): Promise<Viewer | null> {
  if (accessConfigured(env)) {
    const id = await identifyAccessUser(request, env);
    if (!id) return null;
    return { email: id.email, isOwner: isOwnerEmail(id.email, env), mode: "access" };
  }
  const owner = (env.TENANT_OWNER_EMAIL || "owner@local").toLowerCase();
  return { email: owner, isOwner: true, mode: "open-dev" };
}

/** Hard viewer — throws a 401 Response when no viewer resolves. */
export async function requireViewer(
  request: Request,
  env: AppEnv,
): Promise<Viewer> {
  const viewer = await getViewer(request, env);
  if (!viewer) throw unauthorized("CF Access required for this fork");
  return viewer;
}
