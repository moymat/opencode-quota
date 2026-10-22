import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { fetchWithTimeout, readBoundedJsonResponse, redactCookieSecrets } from "./http.js";

const MISTRAL_VIBE_USAGE_URL = "https://chat.mistral.ai/api/code-trpc/apiKey.getUsage";
const MISTRAL_VIBE_REQUEST_TIMEOUT_MS = 10_000;
const MISTRAL_VIBE_RESPONSE_MAX_BYTES = 256 * 1024;
const MISTRAL_VIBE_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0";

export interface MistralVibeUsage {
  /** Provider-reported percentage of the monthly allowance already used. */
  usagePercentage: number;
  paygEnabled: boolean;
  resetAtIso: string | null;
}

export type MistralVibeUsageResult =
  | { success: true; data: MistralVibeUsage }
  | { success: false; error: string };

/** The API returns 401/403 (or a redirect) when the session cookie is rejected. */
export const MISTRAL_VIBE_SESSION_EXPIRED_ERROR = "Mistral Vibe session expired; update the cookie";

export function isMistralVibeSessionExpiredError(result: MistralVibeUsageResult): boolean {
  return !result.success && result.error === MISTRAL_VIBE_SESSION_EXPIRED_ERROR;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseResetTime(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("invalid reset time");

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid reset time");

  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  if (year < 1970 || year > 9999) throw new Error("invalid reset time");
  return date.toISOString();
}

export function parseMistralVibeUsageResponse(json: unknown): MistralVibeUsage {
  if (!isRecord(json) || !isRecord(json.result)) throw new Error("missing result envelope");
  if (!isRecord(json.result.data) || !isRecord(json.result.data.json)) {
    throw new Error("missing usage payload");
  }

  const payload = json.result.data.json;
  const usagePercentage = parseNonNegativeNumber(payload.usagePercentage);
  if (usagePercentage === null) throw new Error("invalid usage percentage");
  if (typeof payload.paygEnabled !== "boolean") throw new Error("invalid pay-as-you-go state");

  return {
    usagePercentage,
    paygEnabled: payload.paygEnabled,
    resetAtIso: parseResetTime(payload.resetAt),
  };
}

function sanitizeRequestError(error: unknown, cookie: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    sanitizeSingleLineDisplaySnippet(redactCookieSecrets(message, cookie), 120) || "request failed"
  );
}

export async function queryMistralVibeUsage(
  cookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<MistralVibeUsageResult> {
  try {
    return await fetchWithTimeout(MISTRAL_VIBE_USAGE_URL, {
      request: {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "*/*",
          Cookie: cookie,
          Referer: "https://chat.mistral.ai/code/extensions",
          "User-Agent": MISTRAL_VIBE_USER_AGENT,
          "trpc-accept": "application/json",
        },
      },
      timeoutMs: options.requestTimeoutMs ?? MISTRAL_VIBE_REQUEST_TIMEOUT_MS,
      consume: async (response, timeoutSignal): Promise<MistralVibeUsageResult> => {
        if (
          response.status === 401 ||
          response.status === 403 ||
          (response.status >= 300 && response.status < 400)
        ) {
          return {
            success: false,
            error: MISTRAL_VIBE_SESSION_EXPIRED_ERROR,
          };
        }
        if (!response.ok) {
          return {
            success: false,
            error: `Mistral Vibe request failed (HTTP ${response.status})`,
          };
        }

        let json: unknown;
        try {
          json = await readBoundedJsonResponse(response, MISTRAL_VIBE_RESPONSE_MAX_BYTES);
        } catch (error) {
          if (timeoutSignal.aborted) throw error;
          return {
            success: false,
            error: "Mistral Vibe response could not be parsed",
          };
        }

        try {
          return { success: true, data: parseMistralVibeUsageResponse(json) };
        } catch {
          return {
            success: false,
            error: "Mistral Vibe response did not match the expected schema",
          };
        }
      },
    });
  } catch (error) {
    return {
      success: false,
      error: `Mistral Vibe request failed: ${sanitizeRequestError(error, cookie)}`,
    };
  }
}
