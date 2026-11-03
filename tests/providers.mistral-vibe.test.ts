import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { mistralVibeProvider } from "../src/providers/mistral-vibe.js";
import { fetchRows, rowSummary } from "./helpers/provider-fetch.js";

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

const RESET = "2026-11-01T00:00:00.000Z";

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
      rootResetAtIso: RESET,
      api: { usagePercentage: 10, budget: 25.5, currency: "EUR", resetAtIso: RESET },
      vibe: { usagePercentage: 50, budget: 255, currency: "EUR", resetAtIso: RESET },
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
      resetAtIso: RESET,
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
    await expect(mistralVibeProvider.isAvailable({ config: {} } as never)).resolves.toBe(expected);
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

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toEqual({ code: "not_configured" });
    expect(mocks.queryMistralVibeUsage).not.toHaveBeenCalled();
    expect(mocks.queryMistralAdminBudget).not.toHaveBeenCalled();
  });

  it("projects invalid configuration as a safe attempted error", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({
      state: "invalid",
      source: "env:MISTRAL_VIBE_COOKIE",
      error: "Invalid cookie header",
    });

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "not_configured" });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "Mistral Vibe: Invalid config (env:MISTRAL_VIBE_COOKIE): Invalid cookie header",
    });
    expect(JSON.stringify(fetched)).not.toContain("ory_session");
  });

  it("renders API and Vibe budget rows with typed euro amounts", async () => {
    configured();
    adminBudget();
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([
      ["mistral-vibe.api", null, "API", "month", "90 (2.55 EUR of 25.5 EUR)", RESET],
      ["mistral-vibe.vibe", null, "Vibe", "month", "50 (127.5 EUR of 255 EUR)", RESET],
    ]);
    expect(fetched.rows[0]).toMatchObject({
      type: "quota",
      method: "dashboard_scrape",
      authority: "provider_reported",
      prominence: "primary",
      remaining: { decimal: "22.95", unit: { kind: "currency", code: "EUR" } },
    });
  });

  it("combines both budgets into one row when the layout is combined", async () => {
    configured();
    adminBudget();
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider, { mistralBudgetLayout: "combined" });

    expect(fetched.error).toBeUndefined();
    expect(fetched.rows).toHaveLength(1);
    expect(fetched.rows[0]).toMatchObject({
      id: "mistral-vibe.monthly",
      label: "Monthly",
      window: "month",
      used: { decimal: "130.05", unit: { kind: "currency", code: "EUR" } },
      limit: { decimal: "280.5", unit: { kind: "currency", code: "EUR" } },
      remaining: { decimal: "150.45", unit: { kind: "currency", code: "EUR" } },
      resetsAt: RESET,
    });
    expect(fetched.rows[0]?.percentRemaining).toBeCloseTo(53.6363636364, 6);
  });

  it("keeps split rows when combined layout has no Vibe budget", async () => {
    configured();
    adminBudget({ vibe: null });
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider, { mistralBudgetLayout: "combined" });

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows).map((row) => row[2])).toEqual(["API", "Vibe"]);
    expect(fetched.rows[1]?.used).toBeUndefined();
  });

  it("keeps split rows when the two budgets use different currencies", async () => {
    configured();
    adminBudget({
      vibe: { usagePercentage: 50, budget: 255, currency: "USD", resetAtIso: RESET },
    });
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider, { mistralBudgetLayout: "combined" });

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows).map((row) => row[2])).toEqual(["API", "Vibe"]);
  });

  it("invites a sign-in for the API row when the admin endpoint rejects the session", async () => {
    configured("zen-browser:/home/u/.config/zen/prof");
    mocks.queryMistralAdminBudget.mockResolvedValueOnce({
      success: false,
      error: "Mistral admin session expired; update the cookie",
    });
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.rows).toHaveLength(1);
    expect(fetched.rows[0]).toMatchObject({
      id: "mistral-vibe.vibe",
      label: "Vibe",
      percentRemaining: 91.58353656,
    });
    expect(fetched.rows[0]?.used).toBeUndefined();
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value:
        "Mistral API: Mistral admin session expired; update the cookie Sign in again at admin.mistral.ai in Zen browser.",
    });
    expect(JSON.stringify(fetched)).not.toContain("session-secret");
  });

  it("renders no API row and no error when the plan reports no API credits", async () => {
    configured();
    adminBudget({ rootResetAtIso: null, api: null });
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.error).toBeUndefined();
    expect(fetched.rows).toHaveLength(1);
    expect(fetched.rows[0]?.label).toBe("Vibe");
  });

  it("keeps both budget rows when the chat API fails", async () => {
    configured();
    adminBudget();
    mocks.queryMistralVibeUsage.mockResolvedValueOnce({
      success: false,
      error: "Mistral Vibe request failed (HTTP 500)",
    });

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.error).toBeUndefined();
    expect(fetched.rows).toHaveLength(2);
    expect(fetched.debug).toContainEqual({ key: "chat_source", value: "failed" });
  });

  it("falls back to the chat API for the Vibe row when the plan reports no Vibe budget", async () => {
    configured();
    adminBudget({ vibe: null });
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([
      ["mistral-vibe.api", null, "API", "month", "90 (2.55 EUR of 25.5 EUR)", RESET],
      ["mistral-vibe.vibe", null, "Vibe", "month", 91.58353656, RESET],
    ]);
    expect(fetched.debug).toContainEqual({ key: "vibe_source", value: "chat-api" });
  });

  it("invites a sign-in for both rows when neither endpoint is reachable", async () => {
    configured("zen-browser:/home/u/.config/zen/prof");
    mocks.queryMistralAdminBudget.mockResolvedValueOnce({
      success: false,
      error: "Mistral admin session expired; update the cookie",
    });
    mocks.queryMistralVibeUsage.mockResolvedValueOnce({
      success: false,
      error: "Mistral Vibe session expired; update the cookie",
    });

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        {
          key: "error",
          value:
            "Mistral API: Mistral admin session expired; update the cookie Sign in again at admin.mistral.ai in Zen browser.",
        },
        {
          key: "error",
          value:
            "Mistral Vibe: Mistral Vibe session expired; update the cookie Sign in again at chat.mistral.ai in Zen browser.",
        },
      ]),
    );
    expect(JSON.stringify(fetched)).not.toContain("session-secret");
  });

  it("reports non-session failures as plain errors", async () => {
    configured();
    mocks.queryMistralAdminBudget.mockResolvedValueOnce({
      success: false,
      error: "Mistral admin request failed (HTTP 500)",
    });
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.error).toMatchObject({ code: "provider_error", status: 500 });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "Mistral API: Mistral admin request failed (HTTP 500)",
    });
  });

  it("uses the root budget reset when a line reports none", async () => {
    configured();
    adminBudget({
      rootResetAtIso: "2026-12-01T00:00:00.000Z",
      api: { usagePercentage: 10, budget: 25.5, currency: "EUR", resetAtIso: null },
    });
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.rows[0]?.resetsAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("uses the chat reset as the last reset fallback", async () => {
    configured();
    adminBudget({
      rootResetAtIso: null,
      api: { usagePercentage: 10, budget: 25.5, currency: "EUR", resetAtIso: null },
      vibe: { usagePercentage: 50, budget: 255, currency: "EUR", resetAtIso: null },
    });
    chatUsage({ resetAtIso: "2026-11-05T00:00:00.000Z" });

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.rows.map((row) => row.resetsAt)).toEqual([
      "2026-11-05T00:00:00.000Z",
      "2026-11-05T00:00:00.000Z",
    ]);
  });

  it("falls back to the root reset for a chat-sourced Vibe row without reset", async () => {
    configured();
    adminBudget({ rootResetAtIso: "2026-12-01T00:00:00.000Z", vibe: null });
    chatUsage({ resetAtIso: null });

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.rows[1]).toMatchObject({
      label: "Vibe",
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it("supports over-limit usage with a clamped remaining amount", async () => {
    configured();
    adminBudget({
      vibe: { usagePercentage: 120, budget: 255, currency: "EUR", resetAtIso: null },
    });
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.error).toBeUndefined();
    expect(fetched.rows[1]?.percentRemaining).toBeCloseTo(-20, 8);
    expect(fetched.rows[1]).toMatchObject({
      used: { decimal: "306", unit: { kind: "currency", code: "EUR" } },
      remaining: { decimal: "0", unit: { kind: "currency", code: "EUR" } },
    });
  });

  it("exposes safe usage facts and euro amounts in debug details", async () => {
    configured();
    adminBudget();
    chatUsage();

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "admin_source", value: "ok" },
        { key: "chat_source", value: "ok" },
        { key: "vibe_source", value: "admin" },
        { key: "api_usage_percentage", value: "10.000000" },
        { key: "vibe_usage_percentage", value: "50.000000" },
        { key: "vibe_payg_enabled", value: "false" },
        { key: "api_reset_at", value: RESET },
        { key: "vibe_reset_at", value: RESET },
        { key: "api_budget", value: "25.5 EUR" },
        { key: "api_used", value: "2.55 EUR" },
        { key: "vibe_budget", value: "255 EUR" },
        { key: "vibe_used", value: "127.5 EUR" },
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

    const fetched = await fetchRows(mistralVibeProvider);

    expect(mocks.queryMistralAdminBudget).toHaveBeenCalledTimes(2);
    expect(mocks.queryMistralAdminBudget).toHaveBeenNthCalledWith(1, 'ory_session_x="dead"', {
      requestTimeoutMs: undefined,
    });
    expect(mocks.queryMistralAdminBudget).toHaveBeenNthCalledWith(2, "ory_session_y=fresh", {
      requestTimeoutMs: undefined,
    });
    expect(mocks.queryMistralVibeUsage).toHaveBeenCalledTimes(1);
    expect(fetched.error).toBeUndefined();
    expect(fetched.rows[0]?.percentRemaining).toBeCloseTo(90, 8);
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

    const fetched = await fetchRows(mistralVibeProvider);

    expect(mocks.queryMistralAdminBudget).toHaveBeenCalledTimes(1);
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "Mistral API: Mistral admin request failed (HTTP 500)",
    });
  });

  it("passes the configured cookie source to the resolver", async () => {
    mocks.resolveMistralVibeConfigCached.mockResolvedValueOnce({ state: "none" });

    await fetchRows(mistralVibeProvider, { mistralCookieSource: "zen-browser" });

    expect(mocks.resolveMistralVibeConfigCached).toHaveBeenCalledWith(
      expect.objectContaining({ source: "zen-browser" }),
    );
  });

  it("exposes Zen browser diagnostics in debug details", async () => {
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

    const fetched = await fetchRows(mistralVibeProvider);

    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "zen_browser_profile", value: "/zen/prof" },
        { key: "zen_browser_cookie_count", value: "2" },
      ]),
    );
  });
});
