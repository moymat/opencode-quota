import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  resolveMistralVibeConfigCached: vi.fn(),
  getMistralVibeConfigDiagnosticsCached: vi.fn(),
  queryMistralVibeUsage: vi.fn(),
  queryMistralAdminBudget: vi.fn(),
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

vi.mock("../src/lib/mistral-budget.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/mistral-budget.js")>();
  return {
    ...original,
    queryMistralAdminBudget: mocks.queryMistralAdminBudget,
  };
});

import { mistralVibeProvider } from "../src/providers/mistral-vibe.js";

const quotaAccounting = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const EUR = { kind: "currency", code: "EUR" } as const;

function context(config: Record<string, unknown> = {}): any {
  return { config };
}

function configured(source = "env:MISTRAL_VIBE_COOKIE"): void {
  mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
    state: "configured",
    source,
    config: { cookie: 'ory_session_x="session-secret"' },
  });
}

function adminBudget(overrides: Record<string, unknown> = {}): void {
  mocks.queryMistralAdminBudget.mockResolvedValueOnce({
    success: true,
    data: {
      rootResetAtIso: "2026-11-01T00:00:00.000Z",
      api: {
        usagePercentage: 10,
        budget: 25.5,
        currency: "EUR",
        resetAtIso: "2026-11-01T00:00:00.000Z",
      },
      vibe: {
        usagePercentage: 50,
        budget: 255,
        currency: "EUR",
        resetAtIso: "2026-11-01T00:00:00.000Z",
      },
      ...overrides,
    },
  });
}

function chatUsage(overrides: Record<string, unknown> = {}): void {
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
    expect(mocks.queryMistralAdminBudget).not.toHaveBeenCalled();
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

  it("renders API and Vibe budget bars with typed euro basis facts", async () => {
    configured();
    adminBudget();
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      accounting: quotaAccounting,
      name: "Mistral API Monthly",
      group: "Mistral API",
      percentRemaining: 90,
      resetTimeIso: "2026-11-01T00:00:00.000Z",
      semantic: {
        metric: { kind: "window", window: "month" },
        prominence: "primary",
      },
      basis: {
        used: {
          quantity: { decimal: "2.55", unit: EUR },
          authority: "locally_derived",
        },
        limit: {
          quantity: { decimal: "25.5", unit: EUR },
          authority: "provider_reported",
        },
        remaining: {
          quantity: { decimal: "22.95", unit: EUR },
          authority: "locally_derived",
        },
      },
      sortPriority: 0,
    });
    expect(result.entries[1]).toEqual({
      accounting: quotaAccounting,
      name: "Mistral Vibe Monthly",
      group: "Mistral Vibe",
      percentRemaining: 50,
      resetTimeIso: "2026-11-01T00:00:00.000Z",
      semantic: {
        metric: { kind: "window", window: "month" },
        prominence: "primary",
      },
      basis: {
        used: {
          quantity: { decimal: "127.5", unit: EUR },
          authority: "locally_derived",
        },
        limit: {
          quantity: { decimal: "255", unit: EUR },
          authority: "provider_reported",
        },
        remaining: {
          quantity: { decimal: "127.5", unit: EUR },
          authority: "locally_derived",
        },
      },
      sortPriority: 0,
    });
    visibleEntries(result.entries, "mistral-vibe");
  });

  it("invites a sign-in for the API line when the admin endpoint rejects the session", async () => {
    configured("zen-browser:/home/u/.config/zen/prof");
    mocks.queryMistralAdminBudget.mockResolvedValueOnce({
      success: false,
      error: "Mistral admin session expired; update the cookie",
    });
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expect(result.attempted).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      name: "Mistral Vibe Monthly",
      group: "Mistral Vibe",
      percentRemaining: 91.58353656,
    });
    expect(result.entries[0]).not.toHaveProperty("basis");
    expect(result.errors).toEqual([
      {
        label: "Mistral API",
        message:
          "Mistral admin session expired; update the cookie Sign in again at admin.mistral.ai in Zen browser.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("session-secret");
    visibleEntries(result.entries, "mistral-vibe");
  });

  it("renders no API line and no error when the plan reports no API credits", async () => {
    configured();
    adminBudget({ rootResetAtIso: null, api: null });
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(1);
    expect(result.entries.every((entry) => entry.group === "Mistral Vibe")).toBe(true);
    visibleEntries(result.entries, "mistral-vibe");
  });

  it("keeps both budget bars when the chat API fails", async () => {
    configured();
    adminBudget();
    mocks.queryMistralVibeUsage.mockResolvedValueOnce({
      success: false,
      error: "Mistral Vibe request failed (HTTP 500)",
    });

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.some((entry) => entry.name === "mistral-vibe-payg")).toBe(false);
    expect(result.statusDetails).toEqual(
      expect.arrayContaining([{ key: "chat_source", value: "failed" }]),
    );
    visibleEntries(result.entries, "mistral-vibe");
  });

  it("falls back to the chat API for the Vibe line when the plan reports no Vibe budget", async () => {
    configured();
    adminBudget({ vibe: null });
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]).toMatchObject({
      name: "Mistral Vibe Monthly",
      group: "Mistral Vibe",
      percentRemaining: 91.58353656,
    });
    expect(result.entries[1]).not.toHaveProperty("basis");
    expect(result.statusDetails).toEqual(
      expect.arrayContaining([{ key: "vibe_source", value: "chat-api" }]),
    );
    visibleEntries(result.entries, "mistral-vibe");
  });

  it("invites a sign-in for both lines when neither endpoint is reachable", async () => {
    configured("zen-browser:/home/u/.config/zen/prof");
    mocks.queryMistralAdminBudget.mockResolvedValueOnce({
      success: false,
      error: "Mistral admin session expired; update the cookie",
    });
    mocks.queryMistralVibeUsage.mockResolvedValueOnce({
      success: false,
      error: "Mistral Vibe session expired; update the cookie",
    });

    const result = await mistralVibeProvider.fetch(context());

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([
      {
        label: "Mistral API",
        message:
          "Mistral admin session expired; update the cookie Sign in again at admin.mistral.ai in Zen browser.",
      },
      {
        label: "Mistral Vibe",
        message:
          "Mistral Vibe session expired; update the cookie Sign in again at chat.mistral.ai in Zen browser.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it("reports non-session failures as plain errors", async () => {
    configured();
    mocks.queryMistralAdminBudget.mockResolvedValueOnce({
      success: false,
      error: "Mistral admin request failed (HTTP 500)",
    });
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expect(result.errors).toEqual([
      { label: "Mistral API", message: "Mistral admin request failed (HTTP 500)" },
    ]);
  });

  it("uses the root budget reset when a line reports none", async () => {
    configured();
    adminBudget({
      rootResetAtIso: "2026-12-01T00:00:00.000Z",
      api: {
        usagePercentage: 10,
        budget: 25.5,
        currency: "EUR",
        resetAtIso: null,
      },
    });
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expect(result.entries[0]).toMatchObject({
      resetTimeIso: "2026-12-01T00:00:00.000Z",
    });
  });

  it("uses the chat reset as the last reset fallback", async () => {
    configured();
    adminBudget({
      rootResetAtIso: null,
      api: { usagePercentage: 10, budget: 25.5, currency: "EUR", resetAtIso: null },
      vibe: { usagePercentage: 50, budget: 255, currency: "EUR", resetAtIso: null },
    });
    chatUsage({ resetAtIso: "2026-11-05T00:00:00.000Z" });

    const result = await mistralVibeProvider.fetch(context());

    expect(result.entries[0]).toMatchObject({ resetTimeIso: "2026-11-05T00:00:00.000Z" });
    expect(result.entries[1]).toMatchObject({ resetTimeIso: "2026-11-05T00:00:00.000Z" });
  });

  it("falls back to the root reset for a chat-sourced Vibe line without reset", async () => {
    configured();
    adminBudget({
      rootResetAtIso: "2026-12-01T00:00:00.000Z",
      vibe: null,
    });
    chatUsage({ resetAtIso: null });

    const result = await mistralVibeProvider.fetch(context());

    expect(result.entries[1]).toMatchObject({
      name: "Mistral Vibe Monthly",
      resetTimeIso: "2026-12-01T00:00:00.000Z",
    });
  });

  it("supports over-limit usage with a clamped remaining basis", async () => {
    configured();
    adminBudget({
      vibe: { usagePercentage: 120, budget: 255, currency: "EUR", resetAtIso: null },
    });
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[1]?.percentRemaining).toBeCloseTo(-20, 8);
    expect(result.entries[1]).toMatchObject({
      basis: {
        used: {
          quantity: { decimal: "306", unit: EUR },
          authority: "locally_derived",
        },
        remaining: {
          quantity: { decimal: "0", unit: EUR },
          authority: "locally_derived",
        },
      },
    });
  });

  it("exposes safe usage facts and euro amounts in details", async () => {
    configured();
    adminBudget();
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expect(result.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "admin_source", value: "ok" },
        { key: "chat_source", value: "ok" },
        { key: "vibe_source", value: "admin" },
        { key: "api_usage_percentage", value: "10.000000" },
        { key: "vibe_usage_percentage", value: "50.000000" },
        { key: "vibe_payg_enabled", value: "false" },
        { key: "api_reset_at", value: "2026-11-01T00:00:00.000Z" },
        { key: "vibe_reset_at", value: "2026-11-01T00:00:00.000Z" },
      ]),
    );
    expect(result.rawDetails).toEqual(
      expect.arrayContaining([
        { key: "api_budget", value: "EUR 25.50" },
        { key: "api_used", value: "EUR 2.55" },
        { key: "vibe_budget", value: "EUR 255.00" },
        { key: "vibe_used", value: "EUR 127.50" },
      ]),
    );
  });

  it("tries alternate cookies when the primary session expired", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env:MISTRAL_VIBE_COOKIE",
      config: { cookie: 'ory_session_x="dead"', alternates: ["ory_session_y=fresh"] },
    });
    mocks.queryMistralAdminBudget
      .mockResolvedValueOnce({
        success: false,
        error: "Mistral admin session expired; update the cookie",
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          rootResetAtIso: null,
          api: null,
          vibe: { usagePercentage: 10, budget: 255, currency: "EUR", resetAtIso: null },
        },
      });
    mocks.queryMistralVibeUsage.mockResolvedValueOnce({
      success: true,
      data: { usagePercentage: 10, paygEnabled: false, resetAtIso: null },
    });

    const result = await mistralVibeProvider.fetch(context());

    expect(mocks.queryMistralAdminBudget).toHaveBeenCalledTimes(2);
    expect(mocks.queryMistralAdminBudget).toHaveBeenNthCalledWith(1, 'ory_session_x="dead"', {
      requestTimeoutMs: undefined,
    });
    expect(mocks.queryMistralAdminBudget).toHaveBeenNthCalledWith(2, "ory_session_y=fresh", {
      requestTimeoutMs: undefined,
    });
    expect(mocks.queryMistralVibeUsage).toHaveBeenCalledTimes(1);
    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]?.percentRemaining).toBeCloseTo(90, 8);
  });

  it("does not try admin alternates for non-session errors", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env:MISTRAL_VIBE_COOKIE",
      config: { cookie: "ory_session_x=one", alternates: ["ory_session_y=two"] },
    });
    mocks.queryMistralAdminBudget.mockResolvedValueOnce({
      success: false,
      error: "Mistral admin request failed (HTTP 500)",
    });
    chatUsage();

    const result = await mistralVibeProvider.fetch(context());

    expect(mocks.queryMistralAdminBudget).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([
      { label: "Mistral API", message: "Mistral admin request failed (HTTP 500)" },
    ]);
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
