import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/lib/http.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/http.js")>();
  return {
    ...original,
    fetchWithTimeout: mocks.fetchWithTimeout,
  };
});

import {
  parseMistralAdminBudgetResponse,
  queryMistralAdminBudget,
} from "../src/lib/mistral-budget.js";

const cookie = 'ory_session_coolcurranf83m3srkfl="session-secret"';

const EXPECTED_URL = `https://admin.mistral.ai/api/local-trpc/billing.budget?input=${encodeURIComponent(
  '{"json":null,"meta":{"values":["undefined"],"v":1}}',
)}`;

function budgetLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usage_percentage: 1.592293,
    initial_budget: 25.5,
    currency: "EUR",
    reset_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

function budgetPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    result: {
      data: {
        json: {
          ...budgetLine(),
          api_budget: budgetLine(),
          vibe_budget: budgetLine({
            usage_percentage: 13.744793673333334,
            initial_budget: 255,
          }),
          ...overrides,
        },
      },
    },
  };
}

const EXPECTED_LINE = {
  usagePercentage: 1.592293,
  budget: 25.5,
  currency: "EUR",
  resetAtIso: "2026-11-01T00:00:00.000Z",
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
}

function consumeWith(response: Response): void {
  mocks.fetchWithTimeout.mockImplementationOnce(
    async (
      _url: string,
      options: { consume: (response: Response, signal: AbortSignal) => unknown },
    ) => options.consume(response, new AbortController().signal),
  );
}

describe("Mistral admin budget response parser", () => {
  it("maps the root, api, and vibe budget lines", () => {
    expect(parseMistralAdminBudgetResponse(budgetPayload())).toEqual({
      rootResetAtIso: "2026-11-01T00:00:00.000Z",
      api: EXPECTED_LINE,
      vibe: {
        usagePercentage: 13.744793673333334,
        budget: 255,
        currency: "EUR",
        resetAtIso: "2026-11-01T00:00:00.000Z",
      },
    });
  });

  it("falls back to the root budget for the API line when api_budget is absent", () => {
    const payload = budgetPayload();
    const json = payload as {
      result: { data: { json: Record<string, unknown> } };
    };
    delete json.result.data.json.api_budget;

    expect(parseMistralAdminBudgetResponse(payload)).toEqual({
      rootResetAtIso: "2026-11-01T00:00:00.000Z",
      api: EXPECTED_LINE,
      vibe: {
        usagePercentage: 13.744793673333334,
        budget: 255,
        currency: "EUR",
        resetAtIso: "2026-11-01T00:00:00.000Z",
      },
    });
  });

  it("reports absent sub-budgets as null", () => {
    const payload = budgetPayload();
    const json = payload as {
      result: { data: { json: Record<string, unknown> } };
    };
    delete json.result.data.json.api_budget;
    delete json.result.data.json.vibe_budget;

    expect(parseMistralAdminBudgetResponse(payload)).toEqual({
      rootResetAtIso: "2026-11-01T00:00:00.000Z",
      api: EXPECTED_LINE,
      vibe: null,
    });
  });

  it("preserves zero usage, over-limit usage, and a missing reset time", () => {
    const zero = parseMistralAdminBudgetResponse(
      budgetPayload({
        api_budget: budgetLine({ usage_percentage: 0 }),
        vibe_budget: budgetLine({ usage_percentage: 120, initial_budget: 255, reset_at: null }),
      }),
    );
    expect(zero.api).toMatchObject({ usagePercentage: 0 });
    expect(zero.vibe).toEqual({
      usagePercentage: 120,
      budget: 255,
      currency: "EUR",
      resetAtIso: null,
    });
  });

  it("tolerates a missing root budget", () => {
    const payload = budgetPayload();
    const json = payload as {
      result: { data: { json: Record<string, unknown> } };
    };
    delete json.result.data.json.usage_percentage;
    delete json.result.data.json.initial_budget;
    delete json.result.data.json.currency;
    delete json.result.data.json.reset_at;

    expect(parseMistralAdminBudgetResponse(payload)).toEqual({
      rootResetAtIso: null,
      api: EXPECTED_LINE,
      vibe: {
        usagePercentage: 13.744793673333334,
        budget: 255,
        currency: "EUR",
        resetAtIso: "2026-11-01T00:00:00.000Z",
      },
    });
  });

  it.each([
    ["missing result", {}],
    ["missing data", { result: {} }],
    ["missing json", { result: { data: {} } }],
    ["negative usage", budgetPayload({ api_budget: budgetLine({ usage_percentage: -1 }) })],
    ["string usage", budgetPayload({ api_budget: budgetLine({ usage_percentage: "8.4" }) })],
    [
      "non-finite usage",
      budgetPayload({ api_budget: budgetLine({ usage_percentage: Number.POSITIVE_INFINITY }) }),
    ],
    ["missing budget", budgetPayload({ api_budget: budgetLine({ initial_budget: undefined }) })],
    ["negative budget", budgetPayload({ api_budget: budgetLine({ initial_budget: -5 }) })],
    ["lowercase currency", budgetPayload({ api_budget: budgetLine({ currency: "eur" }) })],
    ["short currency", budgetPayload({ api_budget: budgetLine({ currency: "EU" }) })],
    ["numeric currency", budgetPayload({ api_budget: budgetLine({ currency: 978 }) })],
    ["invalid reset", budgetPayload({ api_budget: budgetLine({ reset_at: "not-a-date" }) })],
    ["wrong reset type", budgetPayload({ api_budget: budgetLine({ reset_at: 123 }) })],
    ["malformed root budget", budgetPayload({ usage_percentage: "high" })],
    ["non-record api_budget", budgetPayload({ api_budget: "none" })],
  ])("rejects %s", (_label, payload) => {
    expect(() => parseMistralAdminBudgetResponse(payload)).toThrow();
  });
});

describe("Mistral admin budget query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the filtered cookie to the admin billing endpoint", async () => {
    consumeWith(jsonResponse(budgetPayload()));

    await expect(queryMistralAdminBudget(cookie)).resolves.toEqual({
      success: true,
      data: {
        rootResetAtIso: "2026-11-01T00:00:00.000Z",
        api: EXPECTED_LINE,
        vibe: {
          usagePercentage: 13.744793673333334,
          budget: 255,
          currency: "EUR",
          resetAtIso: "2026-11-01T00:00:00.000Z",
        },
      },
    });

    const [url, options] = mocks.fetchWithTimeout.mock.calls[0] as [
      string,
      { request: RequestInit },
    ];
    expect(url).toBe(EXPECTED_URL);
    expect(options.request).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "*/*",
        Cookie: cookie,
        Referer: "https://admin.mistral.ai/subscription",
        "x-trpc-source": "nextjs-react",
      },
    });
    expect(options.request.headers).toMatchObject({
      "User-Agent": expect.stringContaining("Firefox"),
    });
  });

  it.each([401, 403, 302])("reports an expired admin session for HTTP %s", async (status) => {
    consumeWith(jsonResponse({}, { status }));

    await expect(queryMistralAdminBudget(cookie)).resolves.toEqual({
      success: false,
      error: "Mistral admin session expired; update the cookie",
    });
  });

  it("reports other HTTP failures without the cookie", async () => {
    consumeWith(jsonResponse({}, { status: 500 }));

    const result = await queryMistralAdminBudget(cookie);

    expect(result).toEqual({
      success: false,
      error: "Mistral admin request failed (HTTP 500)",
    });
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it("reports unparseable and unexpected bodies separately", async () => {
    consumeWith(new Response("not json", { status: 200 }));
    await expect(queryMistralAdminBudget(cookie)).resolves.toEqual({
      success: false,
      error: "Mistral admin response could not be parsed",
    });

    consumeWith(
      jsonResponse({ result: { data: { json: { api_budget: { usage_percentage: -1 } } } } }),
    );
    await expect(queryMistralAdminBudget(cookie)).resolves.toEqual({
      success: false,
      error: "Mistral admin response did not match the expected schema",
    });
  });

  it("redacts cookie values from network errors", async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(
      new Error(`request failed for ${cookie} and session-secret`),
    );

    const result = await queryMistralAdminBudget(cookie);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("[redacted]");
      expect(result.error).not.toContain("session-secret");
    }
  });

  it("wraps timeouts as a request failure", async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("Request timeout after 10s"));

    await expect(queryMistralAdminBudget(cookie)).resolves.toEqual({
      success: false,
      error: "Mistral admin request failed: Request timeout after 10s",
    });
  });
});
