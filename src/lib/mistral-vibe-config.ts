export interface MistralVibeConfig {
  cookie: string;
}

export type ResolvedMistralVibeConfig =
  | { state: "none" }
  | { state: "configured"; config: MistralVibeConfig; source: string }
  | { state: "invalid"; source: string; error: string };

export interface MistralVibeConfigDiagnostics {
  state: ResolvedMistralVibeConfig["state"];
  source: string | null;
  error: string | null;
  checkedPaths: string[];
}

const MISTRAL_VIBE_COOKIE_ENV = "MISTRAL_VIBE_COOKIE";
const ENV_SOURCE = `env:${MISTRAL_VIBE_COOKIE_ENV}`;
const CHECKED_SOURCES = [ENV_SOURCE];

let cachedConfig: ResolvedMistralVibeConfig | null = null;
let cachedAt = 0;

/**
 * Keep only the Ory session cookie(s) from a full browser Cookie header. The
 * dashboard also sends csrf, intercom, and Cloudflare cookies, but the usage
 * endpoint only needs `ory_session_*`. Filtering here means a cookie copied
 * from any browser works without storing unrelated tracking cookies.
 */
export function normalizeMistralVibeCookieHeader(raw: string): string | null {
  if (raw.includes("\r") || raw.includes("\n")) return null;

  const withoutPrefix = raw.trim().replace(/^cookie\s*:\s*/iu, "");
  if (!withoutPrefix) return null;

  const retained = new Map<string, string>();
  for (const rawPair of withoutPrefix.split(";")) {
    const pair = rawPair.trim();
    if (!pair) continue;

    const separator = pair.indexOf("=");
    if (separator <= 0) return null;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) return null;
    if (!name.startsWith("ory_session_")) continue;
    if (!value || retained.has(name)) return null;

    retained.set(name, value);
  }

  if (retained.size === 0) return null;

  return [...retained.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function resolveMistralVibeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMistralVibeConfig | null {
  if (env[MISTRAL_VIBE_COOKIE_ENV] === undefined) return null;

  const cookie = normalizeMistralVibeCookieHeader(env[MISTRAL_VIBE_COOKIE_ENV] ?? "");
  if (!cookie) {
    return {
      state: "invalid",
      source: ENV_SOURCE,
      error: "Invalid cookie header",
    };
  }

  return {
    state: "configured",
    config: { cookie },
    source: ENV_SOURCE,
  };
}

export async function resolveMistralVibeConfig(): Promise<ResolvedMistralVibeConfig> {
  return resolveMistralVibeConfigFromEnv() ?? { state: "none" };
}

export const DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS = 30_000;

export async function resolveMistralVibeConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedMistralVibeConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }

  cachedConfig = await resolveMistralVibeConfig();
  cachedAt = now;
  return cachedConfig;
}

export async function getMistralVibeConfigDiagnostics(): Promise<MistralVibeConfigDiagnostics> {
  const resolved = await resolveMistralVibeConfig();
  return {
    state: resolved.state,
    source: "source" in resolved ? resolved.source : null,
    error: "error" in resolved ? resolved.error : null,
    checkedPaths: CHECKED_SOURCES,
  };
}
