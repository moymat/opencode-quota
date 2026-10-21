import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import { parseMistralVibeUsageResponse, queryMistralVibeUsage } from "../src/lib/mistral-vibe.js";

const cookie = 'ory_session_coolcurranf83m3srkfl="session-secret"';

function usagePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    result: {
      data: {
        json: {
          usagePercentage: 8.41646344,
          paygEnabled: false,
          resetAt: "2026-11-01T00:00:00Z",
          ...overrides,
        },
      },
    },
  };
}

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

describe("Mistral Vibe response parser", () => {
  it("maps the provider-reported usage, reset, and PAYG state", () => {
    expect(parseMistralVibeUsageResponse(usagePayload())).toEqual({
      usagePercentage: 8.41646344,
      paygEnabled: false,
      resetAtIso: "2026-11-01T00:00:00.000Z",
    });
  });

  it("preserves zero usage and over-limit provider values", () => {
    expect(parseMistralVibeUsageResponse(usagePayload({ usagePercentage: 0 }))).toEqual({
      usagePercentage: 0,
      paygEnabled: false,
      resetAtIso: "2026-11-01T00:00:00.000Z",
    });
    expect(parseMistralVibeUsageResponse(usagePayload({ usagePercentage: 120 }))).toEqual({
      usagePercentage: 120,
      paygEnabled: false,
      resetAtIso: "2026-11-01T00:00:00.000Z",
    });
  });

  it("accepts a missing reset time", () => {
    expect(parseMistralVibeUsageResponse(usagePayload({ resetAt: null }))).toEqual({
      usagePercentage: 8.41646344,
      paygEnabled: false,
      resetAtIso: null,
    });
  });

  it.each([
    ["missing result", {}],
    ["missing data", { result: {} }],
    ["missing json", { result: { data: {} } }],
    ["negative usage", usagePayload({ usagePercentage: -1 })],
    ["string usage", usagePayload({ usagePercentage: "8.4" })],
    ["non-finite usage", usagePayload({ usagePercentage: Number.POSITIVE_INFINITY })],
    ["missing PAYG", usagePayload({ paygEnabled: undefined })],
    ["wrong PAYG type", usagePayload({ paygEnabled: "false" })],
    ["invalid reset", usagePayload({ resetAt: "not-a-date" })],
    ["wrong reset type", usagePayload({ resetAt: 123 })],
  ])("rejects %s", (_label, payload) => {
    expect(() => parseMistralVibeUsageResponse(payload)).toThrow();
  });
});

describe("Mistral Vibe usage query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the filtered cookie to the dashboard usage endpoint", async () => {
    consumeWith(jsonResponse(usagePayload()));

    await expect(queryMistralVibeUsage(cookie)).resolves.toEqual({
      success: true,
      data: {
        usagePercentage: 8.41646344,
        paygEnabled: false,
        resetAtIso: "2026-11-01T00:00:00.000Z",
      },
    });

    const [url, options] = mocks.fetchWithTimeout.mock.calls[0] as [
      string,
      { request: RequestInit },
    ];
    expect(url).toBe("https://chat.mistral.ai/api/code-trpc/apiKey.getUsage");
    expect(options.request).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "*/*",
        Cookie: cookie,
        Referer: "https://chat.mistral.ai/code/extensions",
        "trpc-accept": "application/json",
      },
    });
  });

  it.each([401, 403, 302])("reports an expired session for HTTP %s", async (status) => {
    consumeWith(jsonResponse({}, { status }));

    await expect(queryMistralVibeUsage(cookie)).resolves.toEqual({
      success: false,
      error: "Mistral Vibe session expired; update the cookie",
    });
  });

  it("reports other HTTP failures without the cookie", async () => {
    consumeWith(jsonResponse({}, { status: 500 }));

    const result = await queryMistralVibeUsage(cookie);

    expect(result).toEqual({
      success: false,
      error: "Mistral Vibe request failed (HTTP 500)",
    });
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it("reports unparseable and unexpected bodies separately", async () => {
    consumeWith(new Response("not json", { status: 200 }));
    await expect(queryMistralVibeUsage(cookie)).resolves.toEqual({
      success: false,
      error: "Mistral Vibe response could not be parsed",
    });

    consumeWith(jsonResponse({ result: { data: { json: { usagePercentage: -1 } } } }));
    await expect(queryMistralVibeUsage(cookie)).resolves.toEqual({
      success: false,
      error: "Mistral Vibe response did not match the expected schema",
    });
  });

  it("redacts cookie values from network errors", async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(
      new Error(`request failed for ${cookie} and session-secret`),
    );

    const result = await queryMistralVibeUsage(cookie);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("[redacted]");
      expect(result.error).not.toContain("session-secret");
    }
  });

  it("wraps timeouts as a request failure", async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("Request timeout after 10s"));

    await expect(queryMistralVibeUsage(cookie)).resolves.toEqual({
      success: false,
      error: "Mistral Vibe request failed: Request timeout after 10s",
    });
  });
});
