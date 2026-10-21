import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";

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

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MISTRAL_VIBE_RESPONSE_MAX_BYTES) {
      throw new Error("response too large");
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MISTRAL_VIBE_RESPONSE_MAX_BYTES) {
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original read or size-limit error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder().decode(body));
}

function getCookieValues(cookie: string): string[] {
  return cookie.split(";").flatMap((part) => {
    const value = part.slice(part.indexOf("=") + 1).trim();
    if (!value) return [];
    const unquoted = value.replace(/^"(.*)"$/u, "$1");
    return unquoted === value ? [value] : [value, unquoted];
  });
}

function sanitizeRequestError(error: unknown, cookie: string): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [cookie, ...getCookieValues(cookie)]) {
    message = message.split(secret).join("[redacted]");
  }
  return sanitizeSingleLineDisplaySnippet(message, 120) || "request failed";
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
            error: "Mistral Vibe session expired; update the cookie",
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
          json = await readBoundedJson(response);
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
