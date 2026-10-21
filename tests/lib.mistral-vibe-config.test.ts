import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = process.env;
const sessionCookie = 'ory_session_coolcurranf83m3srkfl="MTc5MTM2MjM0MXxhYmM9PQ=="';

const zenMocks = vi.hoisted(() => ({
  readZenBrowserCookies: vi.fn(),
}));

vi.mock("../src/lib/zen-browser-cookies.js", () => ({
  readZenBrowserCookies: zenMocks.readZenBrowserCookies,
}));

function zenCookie(value: string, name = "ory_session_b") {
  return { name, value, host: ".mistral.ai", path: "/", expiryMs: 1 };
}

describe("Mistral Vibe config resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.MISTRAL_VIBE_COOKIE;
    zenMocks.readZenBrowserCookies.mockReset();
    zenMocks.readZenBrowserCookies.mockResolvedValue({
      state: "not-found",
      checkedDirs: ["zen-browser:~/.config/zen"],
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("keeps only Ory session cookies from a full browser header", async () => {
    const { normalizeMistralVibeCookieHeader } = await import("../src/lib/mistral-vibe-config.js");

    expect(
      normalizeMistralVibeCookieHeader(
        ' Cookie: csrftoken=csrf; ory_session_a="one=="; __cf_bm=bm; ' +
          "intercom-id-x=tracking; ory_session_b=two ",
      ),
    ).toBe('ory_session_a="one=="; ory_session_b=two');
  });

  it("accepts a single session cookie and preserves quoted values", async () => {
    const { normalizeMistralVibeCookieHeader } = await import("../src/lib/mistral-vibe-config.js");

    expect(normalizeMistralVibeCookieHeader(sessionCookie)).toBe(sessionCookie);
    expect(normalizeMistralVibeCookieHeader("cookie: ory_session_x=plain")).toBe(
      "ory_session_x=plain",
    );
  });

  it.each([
    ["missing session cookie", "csrftoken=csrf; __cf_bm=bm"],
    ["empty value", "ory_session_x="],
    ["malformed pair", "ory_session_x=one; malformed"],
    ["duplicate name", "ory_session_x=one; ory_session_x=two"],
    ["CR injection", "ory_session_x=one\rignored=value"],
    ["LF injection", "ory_session_x=one\nignored=value"],
    ["blank header", "   "],
  ])("rejects %s", async (_label, raw) => {
    const { normalizeMistralVibeCookieHeader } = await import("../src/lib/mistral-vibe-config.js");
    expect(normalizeMistralVibeCookieHeader(raw)).toBeNull();
  });

  it("reads the cookie from MISTRAL_VIBE_COOKIE", async () => {
    process.env.MISTRAL_VIBE_COOKIE = `Cookie: csrftoken=x; ${sessionCookie}`;
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig()).resolves.toEqual({
      state: "configured",
      source: "env:MISTRAL_VIBE_COOKIE",
      config: { cookie: sessionCookie },
    });
  });

  it("reports an invalid environment value instead of ignoring it", async () => {
    process.env.MISTRAL_VIBE_COOKIE = "csrftoken=csrf";
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig()).resolves.toEqual({
      state: "invalid",
      source: "env:MISTRAL_VIBE_COOKIE",
      error: "Invalid cookie header",
    });
  });

  it("returns none when MISTRAL_VIBE_COOKIE is absent", async () => {
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig()).resolves.toEqual({ state: "none" });
  });

  it("caches the environment value within the configured TTL", async () => {
    process.env.MISTRAL_VIBE_COOKIE = sessionCookie;
    const { resolveMistralVibeConfigCached } = await import("../src/lib/mistral-vibe-config.js");
    const first = await resolveMistralVibeConfigCached({ maxAgeMs: 5_000 });
    process.env.MISTRAL_VIBE_COOKIE = "ory_session_changed=changed";

    await expect(resolveMistralVibeConfigCached({ maxAgeMs: 5_000 })).resolves.toEqual(first);
  });

  it("reports the trusted source without exposing cookie values", async () => {
    process.env.MISTRAL_VIBE_COOKIE = sessionCookie;
    const { getMistralVibeConfigDiagnostics } = await import("../src/lib/mistral-vibe-config.js");
    const diagnostics = await getMistralVibeConfigDiagnostics();

    expect(diagnostics).toEqual({
      state: "configured",
      source: "env:MISTRAL_VIBE_COOKIE",
      error: null,
      checkedPaths: ["env:MISTRAL_VIBE_COOKIE"],
      zenBrowserCheckedDirs: ["zen-browser:~/.config/zen"],
      zenBrowserProfile: null,
      zenBrowserCookiesFound: null,
      zenBrowserError: null,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("ory_session");
  });

  it("falls back to the Zen browser database in auto mode", async () => {
    zenMocks.readZenBrowserCookies.mockResolvedValue({
      state: "ok",
      profileDir: "/home/u/.config/zen/prof.default",
      cookies: [zenCookie('"quoted-value"', "ory_session_a")],
    });
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig()).resolves.toEqual({
      state: "configured",
      source: "zen-browser:/home/u/.config/zen/prof.default",
      config: {
        cookie: 'ory_session_a="quoted-value"',
        alternates: ["ory_session_a=quoted-value"],
      },
    });
  });

  it("keeps the env cookie primary and appends browser cookies as alternates in auto mode", async () => {
    process.env.MISTRAL_VIBE_COOKIE = sessionCookie;
    zenMocks.readZenBrowserCookies.mockResolvedValue({
      state: "ok",
      profileDir: "/zen/prof",
      cookies: [zenCookie("plain")],
    });
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig()).resolves.toEqual({
      state: "configured",
      source: "env:MISTRAL_VIBE_COOKIE",
      config: {
        cookie: sessionCookie,
        alternates: ["ory_session_b=plain"],
      },
    });
  });

  it("env mode never reads the browser database", async () => {
    process.env.MISTRAL_VIBE_COOKIE = sessionCookie;
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig({ source: "env" })).resolves.toEqual({
      state: "configured",
      source: "env:MISTRAL_VIBE_COOKIE",
      config: { cookie: sessionCookie },
    });
    expect(zenMocks.readZenBrowserCookies).not.toHaveBeenCalled();
  });

  it("zen-browser mode ignores the environment cookie", async () => {
    process.env.MISTRAL_VIBE_COOKIE = sessionCookie;
    zenMocks.readZenBrowserCookies.mockResolvedValue({
      state: "ok",
      profileDir: "/zen/prof",
      cookies: [zenCookie("plain")],
    });
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig({ source: "zen-browser" })).resolves.toEqual({
      state: "configured",
      source: "zen-browser:/zen/prof",
      config: { cookie: "ory_session_b=plain" },
    });
  });

  it("prefers the browser cookie when the env value is invalid and the browser has one", async () => {
    process.env.MISTRAL_VIBE_COOKIE = "csrftoken=csrf";
    zenMocks.readZenBrowserCookies.mockResolvedValue({
      state: "ok",
      profileDir: "/zen/prof",
      cookies: [zenCookie("plain")],
    });
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig()).resolves.toMatchObject({
      state: "configured",
      source: "zen-browser:/zen/prof",
    });
  });

  it("reports browser read errors as invalid config", async () => {
    zenMocks.readZenBrowserCookies.mockResolvedValue({
      state: "error",
      error: "database is locked",
      checkedDirs: ["/zen"],
    });
    const { resolveMistralVibeConfig } = await import("../src/lib/mistral-vibe-config.js");

    await expect(resolveMistralVibeConfig()).resolves.toEqual({
      state: "invalid",
      source: "zen-browser",
      error: "database is locked",
    });
  });

  it("caches per cookie source", async () => {
    process.env.MISTRAL_VIBE_COOKIE = sessionCookie;
    zenMocks.readZenBrowserCookies.mockResolvedValue({
      state: "ok",
      profileDir: "/zen/prof",
      cookies: [zenCookie("plain")],
    });
    const { resolveMistralVibeConfigCached } = await import("../src/lib/mistral-vibe-config.js");

    const envResult = await resolveMistralVibeConfigCached({ maxAgeMs: 5_000, source: "env" });
    const zenResult = await resolveMistralVibeConfigCached({
      maxAgeMs: 5_000,
      source: "zen-browser",
    });
    const envCached = await resolveMistralVibeConfigCached({ maxAgeMs: 5_000, source: "env" });

    expect(envResult.source).toBe("env:MISTRAL_VIBE_COOKIE");
    expect(zenResult.source).toBe("zen-browser:/zen/prof");
    expect(envCached).toEqual(envResult);
  });

  it("reports browser diagnostics without exposing cookie values", async () => {
    zenMocks.readZenBrowserCookies.mockResolvedValue({
      state: "ok",
      profileDir: "/zen/prof",
      cookies: [zenCookie("browser-secret")],
    });
    const { getMistralVibeConfigDiagnostics } = await import("../src/lib/mistral-vibe-config.js");
    const diagnostics = await getMistralVibeConfigDiagnostics();

    expect(diagnostics.zenBrowserProfile).toBe("/zen/prof");
    expect(diagnostics.zenBrowserCookiesFound).toBe(1);
    expect(JSON.stringify(diagnostics)).not.toContain("browser-secret");
  });
});
