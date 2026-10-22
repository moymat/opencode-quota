import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { fetchWithTimeout, readBoundedJsonResponse, redactCookieSecrets } from "./http.js";

/**
 * Mistral admin billing budget client.
 *
 * The subscription page at admin.mistral.ai is backed by a tRPC endpoint that
 * reports the monthly credit budgets included in the plan, in the plan
 * currency:
 *
 *   GET https://admin.mistral.ai/api/local-trpc/billing.budget
 *
 * The same Ory session cookie that chat.mistral.ai uses also authenticates
 * this endpoint (the session is stored on the bare mistral.ai domain), so no
 * separate credential is needed. The response is the standard tRPC/superjson
 * envelope:
 *
 *   { "result": { "data": { "json": {
 *       "usage_percentage": 1.592293, "initial_budget": 25.5, ...   // root
 *       "api_budget":  { "usage_percentage": ..., "initial_budget": ..., ... },
 *       "vibe_budget": { "usage_percentage": ..., "initial_budget": ..., ... }
 *   } } } }
 *
 * On individual plans the root budget mirrors api_budget; it doubles as the
 * API-line fallback when api_budget is absent, and as the reset-time fallback
 * for every line (all budgets share the same monthly cycle).
 */

const MISTRAL_BUDGET_INPUT = encodeURIComponent(
  '{"json":null,"meta":{"values":["undefined"],"v":1}}',
);
const MISTRAL_BUDGET_URL = `https://admin.mistral.ai/api/local-trpc/billing.budget?input=${MISTRAL_BUDGET_INPUT}`;
const MISTRAL_BUDGET_REQUEST_TIMEOUT_MS = 10_000;
const MISTRAL_BUDGET_RESPONSE_MAX_BYTES = 256 * 1024;
const MISTRAL_BUDGET_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0";

export interface MistralBudgetLine {
  /** Provider-reported percentage of the monthly allowance already used. */
  usagePercentage: number;
  /** Monthly allowance in the plan currency. */
  budget: number;
  /** ISO 4217 currency code, e.g. "EUR". */
  currency: string;
  resetAtIso: string | null;
}

export interface MistralAdminBudget {
  /** Root budget reset time; fallback when a line reports none. */
  rootResetAtIso: string | null;
  /** La Plateforme API credits included in the subscription, when reported. */
  api: MistralBudgetLine | null;
  /** Vibe (Le Chat) credits included in the subscription, when reported. */
  vibe: MistralBudgetLine | null;
}

export type MistralAdminBudgetResult =
  | { success: true; data: MistralAdminBudget }
  | { success: false; error: string };

/** The API returns 401/403 (or a redirect) when the session cookie is rejected. */
export const MISTRAL_ADMIN_SESSION_EXPIRED_ERROR =
  "Mistral admin session expired; update the cookie";

export function isMistralAdminSessionExpiredError(result: MistralAdminBudgetResult): boolean {
  return !result.success && result.error === MISTRAL_ADMIN_SESSION_EXPIRED_ERROR;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{3}$/u.test(value) ? value : null;
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

function parseBudgetLine(record: Record<string, unknown>): MistralBudgetLine {
  const usagePercentage = parseNonNegativeNumber(record.usage_percentage);
  if (usagePercentage === null) throw new Error("invalid usage percentage");
  const budget = parseNonNegativeNumber(record.initial_budget);
  if (budget === null) throw new Error("invalid budget amount");
  const currency = parseCurrency(record.currency);
  if (currency === null) throw new Error("invalid currency");

  return {
    usagePercentage,
    budget,
    currency,
    resetAtIso: parseResetTime(record.reset_at),
  };
}

/** Absent lines are fine (plan without those credits); present but malformed is not. */
function parseOptionalBudgetLine(value: unknown): MistralBudgetLine | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("invalid budget line");
  return parseBudgetLine(value);
}

export function parseMistralAdminBudgetResponse(json: unknown): MistralAdminBudget {
  if (!isRecord(json) || !isRecord(json.result)) throw new Error("missing result envelope");
  if (!isRecord(json.result.data) || !isRecord(json.result.data.json)) {
    throw new Error("missing budget payload");
  }

  const payload = json.result.data.json;
  // The root budget fields sit at the top level of the payload (on individual
  // plans they mirror api_budget); they double as the API-line fallback when
  // api_budget is absent, and as the reset-time fallback for every line.
  const hasRootLine =
    "usage_percentage" in payload || "initial_budget" in payload || "currency" in payload;
  const rootLine = hasRootLine ? parseBudgetLine(payload) : null;

  return {
    rootResetAtIso: rootLine?.resetAtIso ?? null,
    api: parseOptionalBudgetLine(payload.api_budget) ?? rootLine,
    vibe: parseOptionalBudgetLine(payload.vibe_budget),
  };
}

function sanitizeRequestError(error: unknown, cookie: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    sanitizeSingleLineDisplaySnippet(redactCookieSecrets(message, cookie), 120) || "request failed"
  );
}

export async function queryMistralAdminBudget(
  cookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<MistralAdminBudgetResult> {
  try {
    return await fetchWithTimeout(MISTRAL_BUDGET_URL, {
      request: {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "*/*",
          Cookie: cookie,
          Referer: "https://admin.mistral.ai/subscription",
          "User-Agent": MISTRAL_BUDGET_USER_AGENT,
          "x-trpc-source": "nextjs-react",
        },
      },
      timeoutMs: options.requestTimeoutMs ?? MISTRAL_BUDGET_REQUEST_TIMEOUT_MS,
      consume: async (response, timeoutSignal): Promise<MistralAdminBudgetResult> => {
        if (
          response.status === 401 ||
          response.status === 403 ||
          (response.status >= 300 && response.status < 400)
        ) {
          return {
            success: false,
            error: MISTRAL_ADMIN_SESSION_EXPIRED_ERROR,
          };
        }
        if (!response.ok) {
          return {
            success: false,
            error: `Mistral admin request failed (HTTP ${response.status})`,
          };
        }

        let json: unknown;
        try {
          json = await readBoundedJsonResponse(response, MISTRAL_BUDGET_RESPONSE_MAX_BYTES);
        } catch (error) {
          if (timeoutSignal.aborted) throw error;
          return {
            success: false,
            error: "Mistral admin response could not be parsed",
          };
        }

        try {
          return { success: true, data: parseMistralAdminBudgetResponse(json) };
        } catch {
          return {
            success: false,
            error: "Mistral admin response did not match the expected schema",
          };
        }
      },
    });
  } catch (error) {
    return {
      success: false,
      error: `Mistral admin request failed: ${sanitizeRequestError(error, cookie)}`,
    };
  }
}
