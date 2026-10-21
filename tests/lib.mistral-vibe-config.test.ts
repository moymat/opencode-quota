import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = process.env;
const sessionCookie = 'ory_session_coolcurranf83m3srkfl="MTc5MTM2MjM0MXxhYmM9PQ=="';

describe("Mistral Vibe config resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.MISTRAL_VIBE_COOKIE;
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
    });
    expect(JSON.stringify(diagnostics)).not.toContain("ory_session");
  });
});
