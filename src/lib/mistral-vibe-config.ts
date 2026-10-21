import {
  type ReadZenBrowserCookiesParams,
  readZenBrowserCookies,
  type ZenBrowserCookie,
} from "./zen-browser-cookies.js";

export const MISTRAL_VIBE_COOKIE_SOURCES = ["auto", "env", "zen-browser"] as const;
export type MistralVibeCookieSource = (typeof MISTRAL_VIBE_COOKIE_SOURCES)[number];

export function isMistralVibeCookieSource(value: unknown): value is MistralVibeCookieSource {
  return (
    typeof value === "string" && (MISTRAL_VIBE_COOKIE_SOURCES as readonly string[]).includes(value)
  );
}

export interface MistralVibeConfig {
  cookie: string;
  /**
   * Extra cookie headers to try when the API rejects the primary one, in order.
   * Zen browser reads can return several rows (duplicate hosts/paths, quoted and
   * unquoted forms); a copied env cookie stays fresh until the session rotates.
   */
  alternates?: string[];
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
  zenBrowserCheckedDirs: string[];
  zenBrowserProfile: string | null;
  zenBrowserCookiesFound: number | null;
  zenBrowserError: string | null;
}

const MISTRAL_VIBE_COOKIE_ENV = "MISTRAL_VIBE_COOKIE";
const ENV_SOURCE = `env:${MISTRAL_VIBE_COOKIE_ENV}`;
const CHECKED_SOURCES = [ENV_SOURCE];

const MISTRAL_VIBE_COOKIE_HOST = "mistral.ai";
const MISTRAL_VIBE_COOKIE_NAME_PREFIX = "ory_session_";

let cachedConfig: ResolvedMistralVibeConfig | null = null;
let cachedSource: MistralVibeCookieSource = "auto";
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

function unquoteCookieValue(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** Cookie headers to try for browser rows, deduplicated, quoted form first. */
function cookieHeaderCandidates(cookies: ZenBrowserCookie[]): string[] {
  const candidates: string[] = [];
  const push = (header: string) => {
    if (!candidates.includes(header)) candidates.push(header);
  };
  for (const cookie of cookies) {
    push(`${cookie.name}=${cookie.value}`);
    // The browser may store the value DQUOTE-wrapped; the API accepts both
    // forms, but keep the unquoted one as a fallback.
    const unquoted = unquoteCookieValue(cookie.value);
    if (unquoted !== cookie.value) push(`${cookie.name}=${unquoted}`);
  }
  return candidates;
}

function zenBrowserReadParams(): ReadZenBrowserCookiesParams {
  return {
    namePrefix: MISTRAL_VIBE_COOKIE_NAME_PREFIX,
    hostSuffix: MISTRAL_VIBE_COOKIE_HOST,
  };
}

export async function resolveMistralVibeConfigFromZenBrowser(): Promise<ResolvedMistralVibeConfig> {
  const read = await readZenBrowserCookies(zenBrowserReadParams());
  if (read.state === "error") {
    return {
      state: "invalid",
      source: "zen-browser",
      error: read.error,
    };
  }
  if (read.state === "not-found" || read.cookies.length === 0) {
    return { state: "none" };
  }
  const candidates = cookieHeaderCandidates(read.cookies);
  const [cookie, ...alternates] = candidates;
  return {
    state: "configured",
    config: alternates.length > 0 ? { cookie, alternates } : { cookie },
    source: `zen-browser:${read.profileDir}`,
  };
}

/**
 * Resolves the cookie source for the requested mode. In `auto` the env cookie
 * stays primary when set (explicit override), with Zen browser cookies as
 * fallbacks, so a copied value that dies with a session rotation is replaced
 * automatically by the browser's current session.
 */
export async function resolveMistralVibeConfig(options?: {
  source?: MistralVibeCookieSource;
}): Promise<ResolvedMistralVibeConfig> {
  const source = options?.source ?? "auto";

  const envResult = source === "zen-browser" ? null : resolveMistralVibeConfigFromEnv();
  if (source === "env") return envResult ?? { state: "none" };

  if (source === "auto" && envResult?.state === "configured") {
    const zen = await resolveMistralVibeConfigFromZenBrowser();
    if (zen.state === "configured") {
      const zenCandidates = [zen.config.cookie, ...(zen.config.alternates ?? [])];
      return {
        state: "configured",
        source: envResult.source,
        config: {
          cookie: envResult.config.cookie,
          alternates: zenCandidates,
        },
      };
    }
    return envResult;
  }

  const zen = await resolveMistralVibeConfigFromZenBrowser();
  if (zen.state === "configured") return zen;
  // Surface an invalid env value when the browser has nothing to offer.
  if (source === "auto" && envResult?.state === "invalid") return envResult;
  return zen;
}

export const DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS = 30_000;

export async function resolveMistralVibeConfigCached(params?: {
  maxAgeMs?: number;
  source?: MistralVibeCookieSource;
}): Promise<ResolvedMistralVibeConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS);
  const source = params?.source ?? "auto";
  const now = Date.now();
  if (cachedConfig && cachedSource === source && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }

  cachedConfig = await resolveMistralVibeConfig({ source });
  cachedSource = source;
  cachedAt = now;
  return cachedConfig;
}

export async function getMistralVibeConfigDiagnostics(): Promise<MistralVibeConfigDiagnostics> {
  const resolved = await resolveMistralVibeConfig();
  const zen = await readZenBrowserCookies(zenBrowserReadParams());
  return {
    state: resolved.state,
    source: "source" in resolved ? resolved.source : null,
    error: "error" in resolved ? resolved.error : null,
    checkedPaths: CHECKED_SOURCES,
    zenBrowserCheckedDirs: zen.checkedDirs,
    zenBrowserProfile: zen.state === "ok" ? zen.profileDir : null,
    zenBrowserCookiesFound: zen.state === "ok" ? zen.cookies.length : null,
    zenBrowserError: zen.state === "error" ? zen.error : null,
  };
}

let cachedDiagnostics: MistralVibeConfigDiagnostics | null = null;
let cachedDiagnosticsAt = 0;

/** Diagnostics cached like the config, so a fetch cycle reads the browser once. */
export async function getMistralVibeConfigDiagnosticsCached(params?: {
  maxAgeMs?: number;
}): Promise<MistralVibeConfigDiagnostics> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedDiagnostics && now - cachedDiagnosticsAt < maxAgeMs) {
    return cachedDiagnostics;
  }

  cachedDiagnostics = await getMistralVibeConfigDiagnostics();
  cachedDiagnosticsAt = now;
  return cachedDiagnostics;
}
