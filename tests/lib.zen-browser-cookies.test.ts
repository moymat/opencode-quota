import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  getZenBrowserConfigDirs,
  normalizeCookieExpiryMs,
  readZenBrowserCookies,
  resolveZenBrowserProfileDir,
} from "../src/lib/zen-browser-cookies.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MOZ_COOKIES_SCHEMA = `
  CREATE TABLE moz_cookies (
    id INTEGER PRIMARY KEY,
    originAttributes TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    host TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '/',
    expiry INTEGER NOT NULL,
    lastAccessed INTEGER NOT NULL DEFAULT 0,
    creationTime INTEGER NOT NULL DEFAULT 0,
    isSecure INTEGER NOT NULL DEFAULT 0,
    isHttpOnly INTEGER NOT NULL DEFAULT 0,
    inBrowserElement INTEGER NOT NULL DEFAULT 0,
    sameSite INTEGER NOT NULL DEFAULT 0,
    rawSameSite INTEGER NOT NULL DEFAULT 0,
    schemeMap INTEGER NOT NULL DEFAULT 0
  );
`;

interface CookieSeed {
  name: string;
  value: string;
  host: string;
  path?: string;
  expiry: number;
}

function writeCookiesDb(dbPath: string, cookies: CookieSeed[]): DatabaseSync {
  const writer = new DatabaseSync(dbPath);
  writer.exec(MOZ_COOKIES_SCHEMA);
  const insert = writer.prepare(
    "INSERT INTO moz_cookies (name, value, host, path, expiry) VALUES (?, ?, ?, ?, ?)",
  );
  for (const cookie of cookies) {
    insert.run(cookie.name, cookie.value, cookie.host, cookie.path ?? "/", cookie.expiry);
  }
  return writer;
}

async function makeZenProfile(params: {
  configDir: string;
  profileDirName: string;
  cookies: CookieSeed[];
  installsIni?: string;
  profilesIni?: string;
  keepWriterOpen?: boolean;
}): Promise<{ profileDir: string; writer?: DatabaseSync }> {
  const profileDir = join(params.configDir, params.profileDirName);
  await mkdir(profileDir, { recursive: true });
  const writer = writeCookiesDb(join(profileDir, "cookies.sqlite"), params.cookies);
  if (params.installsIni) {
    await writeFile(join(params.configDir, "installs.ini"), params.installsIni);
  }
  if (params.profilesIni) {
    await writeFile(join(params.configDir, "profiles.ini"), params.profilesIni);
  }
  if (!params.keepWriterOpen) {
    writer.close();
    return { profileDir };
  }
  return { profileDir, writer };
}

const READ_PARAMS = { namePrefix: "ory_session_", hostSuffix: "mistral.ai" };
const NOW_MS = Date.parse("2026-10-22T00:00:00.000Z");
const FUTURE_MS = NOW_MS + 90 * 24 * 60 * 60 * 1000;
const PAST_MS = NOW_MS - 60 * 1000;

describe("normalizeCookieExpiryMs", () => {
  it("keeps millisecond timestamps and converts microsecond timestamps", () => {
    expect(normalizeCookieExpiryMs(FUTURE_MS)).toBe(FUTURE_MS);
    expect(normalizeCookieExpiryMs(FUTURE_MS * 1000)).toBe(FUTURE_MS);
  });

  it.each([
    [0],
    [-5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    ["soon"],
    [null],
  ])("treats %j as a browser-session cookie", (value) => {
    expect(normalizeCookieExpiryMs(value)).toBe(0);
  });
});

describe("getZenBrowserConfigDirs", () => {
  it("prefers XDG_CONFIG_HOME and keeps the classic and flatpak fallbacks", () => {
    const dirs = getZenBrowserConfigDirs({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv);
    expect(dirs[0]).toBe(join("/xdg", "zen"));
    expect(dirs[1].endsWith(join(".zen"))).toBe(true);
    expect(
      dirs.some((dir) => dir.endsWith(join(".var", "app", "app.zen_browser.zen", "config", "zen"))),
    ).toBe(true);
  });
});

describe("resolveZenBrowserProfileDir", () => {
  it("prefers the locked install's default profile from installs.ini", async () => {
    const configDir = await makeTempDir("zen-config-");
    const { profileDir } = await makeZenProfile({
      configDir,
      profileDirName: "aaa.running",
      cookies: [],
      installsIni: `[HASHONE]\nDefault=bbb.other\nLocked=0\n\n[HASHTWO]\nDefault=aaa.running\nLocked=1\n`,
    });
    await makeZenProfile({ configDir, profileDirName: "bbb.other", cookies: [] });
    expect(resolveZenBrowserProfileDir(configDir)).toBe(profileDir);
  });

  it("falls back to the Default=1 profile from profiles.ini", async () => {
    const configDir = await makeTempDir("zen-config-");
    const { profileDir } = await makeZenProfile({
      configDir,
      profileDirName: "ccc.default",
      cookies: [],
      profilesIni: `[Profile0]\nName=Other\nIsRelative=1\nPath=ddd.other\n\n[Profile1]\nName=Default\nIsRelative=1\nPath=ccc.default\nDefault=1\n`,
    });
    await makeZenProfile({ configDir, profileDirName: "ddd.other", cookies: [] });
    expect(resolveZenBrowserProfileDir(configDir)).toBe(profileDir);
  });

  it("falls back to the profile with the newest cookies.sqlite", async () => {
    const configDir = await makeTempDir("zen-config-");
    await makeZenProfile({ configDir, profileDirName: "eee.old", cookies: [] });
    const { profileDir } = await makeZenProfile({
      configDir,
      profileDirName: "fff.new (twilight)",
      cookies: [],
    });
    expect(resolveZenBrowserProfileDir(configDir)).toBe(profileDir);
  });

  it("returns null when no profile has a cookie database", async () => {
    const configDir = await makeTempDir("zen-config-");
    await mkdir(join(configDir, "empty.profile"), { recursive: true });
    expect(resolveZenBrowserProfileDir(configDir)).toBeNull();
  });
});

describe("readZenBrowserCookies", () => {
  it("returns matching session cookies for mistral.ai hosts, freshest first", async () => {
    const configDir = await makeTempDir("zen-config-");
    await makeZenProfile({
      configDir,
      profileDirName: "prof.default",
      cookies: [
        { name: "ory_session_a", value: '"value-a"', host: ".mistral.ai", expiry: FUTURE_MS },
        {
          name: "ory_session_a",
          value: "value-a-old",
          host: ".mistral.ai",
          expiry: FUTURE_MS + 1000,
        },
        { name: "ory_session_b", value: "value-b", host: "chat.mistral.ai", expiry: FUTURE_MS },
        { name: "csrftoken", value: "csrf", host: ".mistral.ai", expiry: FUTURE_MS },
        { name: "ory_session_c", value: "other-host", host: ".example.com", expiry: FUTURE_MS },
        { name: "ory_session_expired", value: "dead", host: ".mistral.ai", expiry: PAST_MS },
        { name: "ory_session_session", value: "session-cookie", host: ".mistral.ai", expiry: 0 },
      ],
    });

    const result = await readZenBrowserCookies({
      ...READ_PARAMS,
      nowMs: NOW_MS,
      configDirs: [configDir],
    });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.cookies.map((cookie) => cookie.value)).toEqual([
      "value-a-old",
      '"value-a"',
      "value-b",
      "session-cookie",
    ]);
    expect(result.cookies.every((cookie) => cookie.name.startsWith("ory_session_"))).toBe(true);
    expect(result.cookies.every((cookie) => cookie.host.endsWith("mistral.ai"))).toBe(true);
  });

  it("accepts microsecond expiry values", async () => {
    const configDir = await makeTempDir("zen-config-");
    await makeZenProfile({
      configDir,
      profileDirName: "prof.default",
      cookies: [
        {
          name: "ory_session_us",
          value: "micros",
          host: ".mistral.ai",
          expiry: FUTURE_MS * 1000,
        },
        { name: "ory_session_old_us", value: "dead", host: ".mistral.ai", expiry: PAST_MS * 1000 },
      ],
    });

    const result = await readZenBrowserCookies({
      ...READ_PARAMS,
      nowMs: NOW_MS,
      configDirs: [configDir],
    });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]).toMatchObject({ name: "ory_session_us", expiryMs: FUTURE_MS });
  });

  it("does not match lookalike domains", async () => {
    const configDir = await makeTempDir("zen-config-");
    await makeZenProfile({
      configDir,
      profileDirName: "prof.default",
      cookies: [
        { name: "ory_session_x", value: "evil", host: "mistral.ai.evil.com", expiry: FUTURE_MS },
        { name: "ory_session_y", value: "evil", host: "notmistral.ai", expiry: FUTURE_MS },
        { name: "ory_session_z", value: "good", host: "mistral.ai", expiry: FUTURE_MS },
      ],
    });

    const result = await readZenBrowserCookies({
      ...READ_PARAMS,
      nowMs: NOW_MS,
      configDirs: [configDir],
    });

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.cookies.map((cookie) => cookie.value)).toEqual(["good"]);
  });

  it("reads cookies committed to the WAL of a running browser", async () => {
    const configDir = await makeTempDir("zen-config-");
    const { writer } = await makeZenProfile({
      configDir,
      profileDirName: "prof.running",
      cookies: [
        { name: "ory_session_wal", value: '"wal-secret"', host: ".mistral.ai", expiry: FUTURE_MS },
      ],
      keepWriterOpen: true,
    });
    try {
      // The writer keeps the database in WAL mode with the row only in the -wal file.
      writer?.exec("PRAGMA journal_mode=WAL;");

      const result = await readZenBrowserCookies({
        ...READ_PARAMS,
        nowMs: NOW_MS,
        configDirs: [configDir],
      });

      expect(result.state).toBe("ok");
      if (result.state !== "ok") return;
      expect(result.cookies.map((cookie) => cookie.name)).toEqual(["ory_session_wal"]);
    } finally {
      writer?.close();
    }
  });

  it("reports not-found when no Zen config directory exists", async () => {
    const missing = join(await makeTempDir("zen-config-"), "no-such-dir");
    const result = await readZenBrowserCookies({
      ...READ_PARAMS,
      nowMs: NOW_MS,
      configDirs: [missing],
    });

    expect(result).toEqual({ state: "not-found", checkedDirs: [missing] });
  });

  it("reports a sanitized error when the cookie database is unreadable", async () => {
    const configDir = await makeTempDir("zen-config-");
    const profileDir = join(configDir, "prof.broken");
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "cookies.sqlite"), "this is not a sqlite database");

    const result = await readZenBrowserCookies({
      ...READ_PARAMS,
      nowMs: NOW_MS,
      configDirs: [configDir],
    });

    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(result)).not.toContain("not a sqlite");
  });

  it("never exposes cookie values in error results", async () => {
    const configDir = await makeTempDir("zen-config-");
    const profileDir = join(configDir, "prof.wrong-schema");
    await mkdir(profileDir, { recursive: true });
    // A valid SQLite database without the moz_cookies table fails the query.
    const writer = new DatabaseSync(join(profileDir, "cookies.sqlite"));
    writer.exec("CREATE TABLE other (id INTEGER PRIMARY KEY);");
    writer.close();

    const result = await readZenBrowserCookies({
      ...READ_PARAMS,
      nowMs: NOW_MS,
      configDirs: [configDir],
    });

    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.error).toContain("moz_cookies");
    expect(result.checkedDirs).toEqual([configDir]);
  });
});
