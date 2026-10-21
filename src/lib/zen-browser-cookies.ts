/**
 * Zen browser cookie reader
 *
 * Reads cookies straight from the Zen browser profile's `cookies.sqlite`
 * (Firefox schema). The database is read through a temporary copy of the file
 * plus its WAL, so a running browser never blocks the read and the latest
 * committed cookies are visible. Only cookies matching the requested host
 * suffix and name prefix are returned.
 *
 * Cookie values are session secrets: callers must never log them, and error
 * results never include them.
 */

import {
  copyFileSync,
  type Dirent,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { openSqliteCopyReadOnly } from "./opencode-sqlite.js";

export interface ZenBrowserCookie {
  name: string;
  /** Raw stored value, DQUOTE-wrapped when the browser stored it quoted. */
  value: string;
  host: string;
  path: string;
  /** Expiry in milliseconds since the epoch; 0 for a browser-session cookie. */
  expiryMs: number;
}

export type ZenBrowserCookieReadResult =
  | { state: "ok"; profileDir: string; checkedDirs: string[]; cookies: ZenBrowserCookie[] }
  | { state: "not-found"; checkedDirs: string[] }
  | { state: "error"; error: string; checkedDirs: string[] };

export interface ReadZenBrowserCookiesParams {
  /** Only cookies whose name starts with this prefix are returned. */
  namePrefix: string;
  /** Only cookies for this bare domain (or its subdomains) are returned. */
  hostSuffix: string;
  nowMs?: number;
  /** Config roots to search, in order; defaults to the usual Zen locations. */
  configDirs?: string[];
}

/** Candidate Zen config roots, in precedence order. */
export function getZenBrowserConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return [
    join(xdgConfig, "zen"),
    join(home, ".zen"),
    // Flatpak
    join(home, ".var", "app", "app.zen_browser.zen", "config", "zen"),
  ];
}

function parseIni(content: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[(.+)\]$/u.exec(line);
    if (section) {
      current = new Map<string, string>();
      sections.set(section[1].trim(), current);
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    current.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return sections;
}

function profileDirHasCookieDb(profileDir: string): boolean {
  return existsSync(join(profileDir, "cookies.sqlite"));
}

function resolveProfilePath(configDir: string, path: string, isRelative: boolean): string {
  return isRelative ? resolve(configDir, path) : resolve(path);
}

function findNewestProfileDir(configDir: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(configDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: { dir: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileDir = join(configDir, entry.name);
    try {
      const stat = statSync(join(profileDir, "cookies.sqlite"));
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { dir: profileDir, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // no cookies.sqlite in this profile
    }
  }
  return newest?.dir ?? null;
}

/**
 * The profile to read: the locked install's default profile from `installs.ini`
 * (the running browser), then the `Default=1` profile from `profiles.ini`, then
 * the profile with the most recently modified `cookies.sqlite`.
 */
export function resolveZenBrowserProfileDir(configDir: string): string | null {
  const installsPath = join(configDir, "installs.ini");
  if (existsSync(installsPath)) {
    let installs: Map<string, Map<string, string>>;
    try {
      installs = parseIni(readFileSync(installsPath, "utf8"));
    } catch {
      installs = new Map();
    }
    // installs.ini holds one section per install (named by hash, or Install<hash>
    // in some builds); each maps to its default profile.
    const candidates: Array<{ locked: boolean; path: string }> = [];
    for (const keys of installs.values()) {
      const defaultProfile = keys.get("Default");
      if (!defaultProfile) continue;
      candidates.push({ locked: keys.get("Locked") === "1", path: defaultProfile });
    }
    const chosen = candidates.find((candidate) => candidate.locked) ?? candidates[0];
    if (chosen) {
      // installs.ini profile paths are relative to the config root.
      const profileDir = resolveProfilePath(configDir, chosen.path, true);
      if (profileDirHasCookieDb(profileDir)) return profileDir;
    }
  }

  const profilesPath = join(configDir, "profiles.ini");
  if (existsSync(profilesPath)) {
    let profiles: Map<string, Map<string, string>>;
    try {
      profiles = parseIni(readFileSync(profilesPath, "utf8"));
    } catch {
      profiles = new Map();
    }
    for (const [section, keys] of profiles) {
      if (!section.toLowerCase().startsWith("profile")) continue;
      if (keys.get("Default") !== "1") continue;
      const path = keys.get("Path");
      if (!path) continue;
      const profileDir = resolveProfilePath(configDir, path, keys.get("IsRelative") === "1");
      if (profileDirHasCookieDb(profileDir)) return profileDir;
    }
  }

  return findNewestProfileDir(configDir);
}

/**
 * Firefox stores expiry as PRTime microseconds; some builds store milliseconds.
 * Millisecond timestamps stay below 1e14 until the year 5138, microsecond
 * timestamps have been above 1e14 since 1973, so the magnitude tells them apart.
 * A stored 0 marks a browser-session cookie, valid while the browser runs.
 */
export function normalizeCookieExpiryMs(expiry: unknown): number {
  if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry < 0) return 0;
  const rounded = Math.round(expiry);
  return rounded > 1e14 ? Math.round(rounded / 1000) : rounded;
}

function hostMatchesCookieDomain(host: string, suffix: string): boolean {
  const bare = suffix.startsWith(".") ? suffix.slice(1) : suffix;
  return host === bare || host === `.${bare}` || host.endsWith(`.${bare}`);
}

interface CookieRow {
  name: unknown;
  value: unknown;
  host: unknown;
  path: unknown;
  expiry: unknown;
}

async function readCookiesFromDb(
  dbPath: string,
  params: ReadZenBrowserCookiesParams,
): Promise<ZenBrowserCookie[]> {
  // Copy the database (and its WAL) so a running browser never blocks the read
  // and the latest committed cookies are visible. The copy is opened read-write
  // so SQLite recovers the copied WAL, then locked to query-only.
  const tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-zen-"));
  try {
    copyFileSync(dbPath, join(tempDir, "cookies.sqlite"));
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) copyFileSync(walPath, join(tempDir, "cookies.sqlite-wal"));

    const db = await openSqliteCopyReadOnly(join(tempDir, "cookies.sqlite"));
    try {
      const rows = db.all<CookieRow>(
        "SELECT name, value, host, path, expiry FROM moz_cookies WHERE substr(name, 1, ?) = ?",
        [params.namePrefix.length, params.namePrefix],
      );
      const nowMs = params.nowMs ?? Date.now();
      const cookies: ZenBrowserCookie[] = [];
      for (const row of rows) {
        if (typeof row.name !== "string" || typeof row.value !== "string") continue;
        if (typeof row.host !== "string" || !hostMatchesCookieDomain(row.host, params.hostSuffix)) {
          continue;
        }
        const expiryMs = normalizeCookieExpiryMs(row.expiry);
        if (expiryMs !== 0 && expiryMs <= nowMs) continue;
        cookies.push({
          name: row.name,
          value: row.value,
          host: row.host,
          path: typeof row.path === "string" ? row.path : "/",
          expiryMs,
        });
      }
      // Dated cookies first, freshest (latest expiry) first; browser-session
      // cookies last because they cannot be ranked.
      cookies.sort((a, b) => {
        if (a.expiryMs === 0) return 1;
        if (b.expiryMs === 0) return -1;
        return b.expiryMs - a.expiryMs;
      });
      return cookies;
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Reads matching cookies from the first Zen config root that has a readable
 * profile. Never throws; read failures come back as an `error` result.
 */
export async function readZenBrowserCookies(
  params: ReadZenBrowserCookiesParams,
): Promise<ZenBrowserCookieReadResult> {
  const configDirs = params.configDirs ?? getZenBrowserConfigDirs();
  const checkedDirs: string[] = [];
  for (const configDir of configDirs) {
    checkedDirs.push(configDir);
    if (!existsSync(configDir)) continue;
    const profileDir = resolveZenBrowserProfileDir(configDir);
    if (!profileDir) continue;
    const dbPath = join(profileDir, "cookies.sqlite");
    try {
      const cookies = await readCookiesFromDb(dbPath, params);
      return { state: "ok", profileDir, checkedDirs, cookies };
    } catch (error) {
      return {
        state: "error",
        error:
          sanitizeSingleLineDisplaySnippet(
            error instanceof Error ? error.message : String(error),
            120,
          ) || "could not read the Zen browser cookie database",
        checkedDirs,
      };
    }
  }
  return { state: "not-found", checkedDirs };
}
