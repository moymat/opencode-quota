import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  resolveMistralVibeConfigCached: vi.fn(),
  queryMistralVibeUsage: vi.fn(),
  getMistralVibeConfigDiagnosticsCached: vi.fn(),
}));

vi.mock("../src/lib/mistral-vibe-config.js", () => ({
  DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS: 30_000,
  resolveMistralVibeConfigCached: mocks.resolveMistralVibeConfigCached,
  getMistralVibeConfigDiagnosticsCached: mocks.getMistralVibeConfigDiagnosticsCached,
}));

vi.mock("../src/lib/mistral-vibe.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/mistral-vibe.js")>();
  return {
    ...original,
    queryMistralVibeUsage: mocks.queryMistralVibeUsage,
  };
});

import { mistralVibeProvider } from "../src/providers/mistral-vibe.js";

const quotaAccounting = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const statusAccounting = {
  resultType: "status",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function context(config: Record<string, unknown> = {}): any {
  return { config };
}

function configured(): void {
  mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
    state: "configured",
    source: "env:MISTRAL_VIBE_COOKIE",
    config: { cookie: 'ory_session_x="session-secret"' },
  });
}

function usage(overrides: Record<string, unknown> = {}): void {
  mocks.queryMistralVibeUsage.mockResolvedValueOnce({
    success: true,
    data: {
      usagePercentage: 8.41646344,
      paygEnabled: false,
      resetAtIso: "2026-11-01T00:00:00.000Z",
      ...overrides,
    },
  });
}

describe("Mistral Vibe provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMistralVibeConfigDiagnosticsCached.mockResolvedValue({
      state: "none",
      source: null,
      error: null,
      checkedPaths: ["env:MISTRAL_VIBE_COOKIE"],
      zenBrowserCheckedDirs: [],
      zenBrowserProfile: null,
      zenBrowserCookiesFound: null,
      zenBrowserError: null,
    });
  });

  it("uses the canonical mistral-vibe provider identity", () => {
    expect(mistralVibeProvider.id).toBe("mistral-vibe");
  });

  it.each([
    [{ state: "configured", config: { cookie: "filtered" }, source: "env" }, true],
    [{ state: "invalid", source: "env", error: "Invalid cookie header" }, false],
    [{ state: "none" }, false],
  ])("reports availability for config state %j", async (configState, expected) => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce(configState);
    await expect(mistralVibeProvider.isAvailable(context())).resolves.toBe(expected);
  });

  it.each([
    ["mistral/mistral-large-latest", true],
    ["mistral-vibe/codestral", true],
    ["mistralai/mistral-small", true],
    ["MISTRAL/MISTRAL-LARGE-LATEST", true],
    ["openai/gpt-5", false],
    ["opencode-go/glm-5", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(mistralVibeProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("does not attempt a request without configuration", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({ state: "none" });

    expectNotAttempted(await mistralVibeProvider.fetch(context()));
    expect(mocks.queryMistralVibeUsage).not.toHaveBeenCalled();
  });

  it("projects invalid configuration as a safe attempted error", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
      state: "invalid",
      source: "env:MISTRAL_VIBE_COOKIE",
      error: "Invalid cookie header",
    });

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "Mistral Vibe");
    expect(result.errors[0]?.message).toBe(
      "Invalid config (env:MISTRAL_VIBE_COOKIE): Invalid cookie header",
    );
    expect(JSON.stringify(result)).not.toContain("ory_session");
  });

  it("maps usage to a monthly remaining percentage and reset", async () => {
    configured();
    usage();

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      accounting: quotaAccounting,
      name: "Mistral Vibe Monthly",
      group: "Mistral Vibe",
      percentRemaining: 91.58353656,
      resetTimeIso: "2026-11-01T00:00:00.000Z",
      semantic: {
        metric: { kind: "window", window: "month" },
        prominence: "primary",
      },
    });
    expect(result.entries[1]).toEqual({
      accounting: statusAccounting,
      kind: "boolean",
      name: "mistral-vibe-payg",
      group: "Mistral Vibe",
      semantic: {
        metric: { kind: "named", name: "Pay-as-you-go" },
        prominence: "supplementary",
      },
      value: false,
    });
    visibleEntries(result.entries, "mistral-vibe");
  });

  it("supports over-limit usage and an enabled PAYG state", async () => {
    configured();
    usage({ usagePercentage: 128.5, paygEnabled: true, resetAtIso: null });

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]?.percentRemaining).toBeCloseTo(-28.5, 8);
    expect(result.entries[1]).toMatchObject({ kind: "boolean", value: true });
    expect(result.entries[0]).not.toHaveProperty("resetTimeIso");
  });

  it("passes an expired session through as a safe provider error", async () => {
    configured();
    mocks.queryMistralVibeUsage.mockResolvedValueOnce({
      success: false,
      error: "Mistral Vibe session expired; update the cookie",
    });

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "Mistral Vibe");
    expect(result.errors[0]?.message).toBe("Mistral Vibe session expired; update the cookie");
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it("exposes safe usage facts in status details", async () => {
    configured();
    usage();

    const result = await mistralVibeProvider.fetch(context());

    expect(result.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "usage_percentage", value: "8.416463" },
        { key: "payg_enabled", value: "false" },
        { key: "reset_at", value: "2026-11-01T00:00:00.000Z" },
      ]),
    );
  });

  it("tries alternate cookies when the primary session expired", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env:MISTRAL_VIBE_COOKIE",
      config: { cookie: 'ory_session_x="dead"', alternates: ["ory_session_y=fresh"] },
    });
    mocks.queryMistralVibeUsage
      .mockResolvedValueOnce({
        success: false,
        error: "Mistral Vibe session expired; update the cookie",
      })
      .mockResolvedValueOnce({
        success: true,
        data: { usagePercentage: 10, paygEnabled: false, resetAtIso: null },
      });

    const result = await mistralVibeProvider.fetch(context());

    expect(mocks.queryMistralVibeUsage).toHaveBeenCalledTimes(2);
    expect(mocks.queryMistralVibeUsage).toHaveBeenNthCalledWith(1, 'ory_session_x="dead"', {
      requestTimeoutMs: undefined,
    });
    expect(mocks.queryMistralVibeUsage).toHaveBeenNthCalledWith(2, "ory_session_y=fresh", {
      requestTimeoutMs: undefined,
    });
    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]?.percentRemaining).toBeCloseTo(90, 8);
  });

  it("does not try alternates for non-session errors", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env:MISTRAL_VIBE_COOKIE",
      config: { cookie: "ory_session_x=one", alternates: ["ory_session_y=two"] },
    });
    mocks.queryMistralVibeUsage.mockResolvedValueOnce({
      success: false,
      error: "Mistral Vibe request failed (HTTP 500)",
    });

    const result = await mistralVibeProvider.fetch(context());

    expect(mocks.queryMistralVibeUsage).toHaveBeenCalledTimes(1);
    expectAttemptedWithErrorLabel(result, "Mistral Vibe");
    expect(result.errors[0]?.message).toBe("Mistral Vibe request failed (HTTP 500)");
  });

  it("adds a Zen sign-in hint for browser-sourced session errors", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "zen-browser:/home/u/.config/zen/prof",
      config: { cookie: "ory_session_x=one" },
    });
    mocks.queryMistralVibeUsage.mockResolvedValueOnce({
      success: false,
      error: "Mistral Vibe session expired; update the cookie",
    });

    const result = await mistralVibeProvider.fetch(context());

    expect(result.errors[0]?.message).toBe(
      "Mistral Vibe session expired; update the cookie Sign in again at chat.mistral.ai in Zen browser.",
    );
    expect(JSON.stringify(result)).not.toContain("ory_session_x=one");
  });

  it("passes the configured cookie source to the resolver", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({ state: "none" });

    await mistralVibeProvider.fetch(context({ mistralVibeCookieSource: "zen-browser" }));

    expect(mocks.resolveMistralVibeConfigCached).toHaveBeenCalledWith(
      expect.objectContaining({ source: "zen-browser" }),
    );
  });

  it("exposes Zen browser diagnostics in status details", async () => {
    mocks.getMistralVibeConfigDiagnosticsCached.mockResolvedValueOnce({
      state: "configured",
      source: "zen-browser:/zen/prof",
      error: null,
      checkedPaths: ["env:MISTRAL_VIBE_COOKIE"],
      zenBrowserCheckedDirs: ["/zen"],
      zenBrowserProfile: "/zen/prof",
      zenBrowserCookiesFound: 2,
      zenBrowserError: null,
    });
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({ state: "none" });

    const result = await mistralVibeProvider.fetch(context());

    expect(result.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "zen_browser_profile", value: "/zen/prof" },
        { key: "zen_browser_cookies", value: "2" },
      ]),
    );
  });
});
