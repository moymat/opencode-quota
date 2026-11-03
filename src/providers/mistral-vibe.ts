/**
 * Mistral: the API and Vibe monthly credit budgets, read from admin.mistral.ai with the user's
 * session cookie (see `mistral-vibe-config.ts`). The admin billing endpoint reports both budgets
 * in the plan currency; the chat code usage API backs the Vibe row up when the admin endpoint
 * gives none.
 */

import type { Amount, AmountUnit } from "../core/types.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import {
  isMistralAdminSessionExpiredError,
  type MistralBudgetLine,
  queryMistralAdminBudget,
} from "../lib/mistral-budget.js";
import {
  DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
  getMistralVibeConfigDiagnosticsCached,
  resolveMistralVibeConfigCached,
} from "../lib/mistral-vibe-config.js";
import {
  isMistralVibeSessionExpiredError,
  type MistralVibeUsage,
  queryMistralVibeUsage,
} from "../lib/mistral-vibe.js";
import { getQuotaProviderRuntimeIds } from "../lib/provider-metadata.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { resolvedCredentialPolicy } from "./cache-policies.js";
import {
  type AccountResult,
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { configStatusDetails, statusDetailsFromRecord } from "./result-helpers.js";

const MISTRAL_LABEL = "Mistral";
const MISTRAL_API_LABEL = "Mistral API";
const MISTRAL_VIBE_LABEL = "Mistral Vibe";
const MISTRAL_RUNTIME_IDS = new Set(getQuotaProviderRuntimeIds("mistral-vibe"));

/** A dashboard scrape: the percentages and amounts are the provider's own. */
const MISTRAL_ROW = { method: "dashboard_scrape", authority: "provider_reported" } as const;

function budgetUnit(line: MistralBudgetLine): AmountUnit {
  return { kind: "currency", code: line.currency };
}

function budgetAmount(line: MistralBudgetLine, amount: number): Amount {
  return { decimal: accountingDecimalFromNumber(amount), unit: budgetUnit(line) };
}

function usedAmount(line: MistralBudgetLine): number {
  return (line.budget * line.usagePercentage) / 100;
}

/** One budget line as a monthly quota row with its typed used/limit/remaining amounts. */
function budgetRow(params: {
  key: string;
  label: string;
  line: MistralBudgetLine;
  resetFallbackIso: string | null;
}): ProviderRow {
  const { line, key, label } = params;
  const used = usedAmount(line);
  const remaining = Math.max(0, line.budget - used);
  const resetsAt = line.resetAtIso ?? params.resetFallbackIso;

  return {
    ...MISTRAL_ROW,
    key,
    label,
    type: "quota",
    prominence: "primary",
    window: MONTHLY.window,
    percentRemaining: 100 - line.usagePercentage,
    used: budgetAmount(line, used),
    limit: budgetAmount(line, line.budget),
    remaining: budgetAmount(line, remaining),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** Both budgets as one row: one bar for the total, and the two pairs in its amounts. */
function combinedBudgetRow(params: {
  api: MistralBudgetLine;
  vibe: MistralBudgetLine;
  resetFallbackIso: string | null;
}): ProviderRow {
  const { api, vibe } = params;
  const used = usedAmount(api) + usedAmount(vibe);
  const budget = api.budget + vibe.budget;
  const remaining = Math.max(0, budget - used);
  const usagePercentage = budget > 0 ? (used / budget) * 100 : 0;
  const resetsAt = api.resetAtIso ?? vibe.resetAtIso ?? params.resetFallbackIso;

  return {
    ...MISTRAL_ROW,
    key: MONTHLY.key,
    label: MONTHLY.label,
    type: "quota",
    prominence: "primary",
    window: MONTHLY.window,
    percentRemaining: 100 - usagePercentage,
    used: budgetAmount(api, used),
    limit: budgetAmount(api, budget),
    remaining: budgetAmount(api, remaining),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** The Vibe row from the chat code usage API, which reports no currency amounts. */
function chatUsageRow(usage: MistralVibeUsage, resetFallbackIso: string | null): ProviderRow {
  const resetsAt = usage.resetAtIso ?? resetFallbackIso;
  return {
    ...MISTRAL_ROW,
    key: "vibe",
    label: "Vibe",
    type: "quota",
    prominence: "primary",
    window: MONTHLY.window,
    percentRemaining: 100 - usage.usagePercentage,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * A rejected session (rotation or revocation) falls through to the next candidate, e.g. the
 * browser's current cookie after an env cookie died.
 */
async function queryWithAlternates<TResult extends { success: boolean }>(
  query: (cookie: string, options: { requestTimeoutMs?: number }) => Promise<TResult>,
  isSessionExpired: (result: TResult) => boolean,
  candidates: string[],
  requestTimeoutMs: number | undefined,
): Promise<TResult> {
  let result = await query(candidates[0] as string, { requestTimeoutMs });
  for (const alternate of candidates.slice(1)) {
    if (result.success || !isSessionExpired(result)) break;
    result = await query(alternate, { requestTimeoutMs });
  }
  return result;
}

function sessionErrorMessage(params: {
  error: string;
  sessionExpired: boolean;
  source: string;
  signInHost: string;
}): string {
  if (!params.sessionExpired) return params.error;
  return params.source.startsWith("zen-browser:")
    ? `${params.error} Sign in again at ${params.signInHost} in Zen browser.`
    : params.error;
}

export const mistralVibeProvider: QuotaProvider = {
  id: "mistral-vibe",
  cachePolicy: resolvedCredentialPolicy("mistral-vibe", async () => {
    const resolved = await resolveMistralVibeConfigCached({
      maxAgeMs: DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured" ? { credential: resolved.config.cookie } : null;
  }),

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveMistralVibeConfigCached({
      maxAgeMs: DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.trim().toLowerCase().split("/", 2);
    return MISTRAL_RUNTIME_IDS.has(provider ?? "");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const diagnostics = await getMistralVibeConfigDiagnosticsCached({
      maxAgeMs: DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
    });
    const debug = [
      ...configStatusDetails(diagnostics),
      ...statusDetailsFromRecord({
        zen_browser_profile: diagnostics.zenBrowserProfile ?? undefined,
        zen_browser_cookie_count:
          diagnostics.zenBrowserCookiesFound === null
            ? undefined
            : String(diagnostics.zenBrowserCookiesFound),
        zen_browser_error: diagnostics.zenBrowserError ?? undefined,
      }),
    ];

    const config = await resolveMistralVibeConfigCached({
      maxAgeMs: DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
      source: ctx.config.mistralCookieSource,
    });

    if (config.state === "none") return { attempted: false, accounts: [], debug };
    if (config.state === "invalid") {
      return {
        attempted: true,
        accounts: [
          failedAccount(MISTRAL_VIBE_LABEL, `Invalid config (${config.source}): ${config.error}`),
        ],
        debug,
      };
    }

    const requestTimeoutMs = ctx.config.requestTimeoutMsConfigured
      ? ctx.config.requestTimeoutMs
      : undefined;
    const candidates = [config.config.cookie, ...(config.config.alternates ?? [])];
    // The admin billing endpoint and the chat code usage API share the same session cookie;
    // both are queried so either can back the Vibe row up.
    const [adminResult, chatResult] = await Promise.all([
      queryWithAlternates(
        queryMistralAdminBudget,
        isMistralAdminSessionExpiredError,
        candidates,
        requestTimeoutMs,
      ),
      queryWithAlternates(
        queryMistralVibeUsage,
        isMistralVibeSessionExpiredError,
        candidates,
        requestTimeoutMs,
      ),
    ]);
    const admin = adminResult.success ? adminResult.data : null;
    const chat = chatResult.success ? chatResult.data : null;

    const rows: ProviderRow[] = [];
    const errors: AccountResult[] = [];
    const detailValues: Record<string, string | undefined> = {
      admin_source: adminResult.success ? "ok" : "failed",
      chat_source: chatResult.success ? "ok" : "failed",
    };

    const combined =
      ctx.config.mistralBudgetLayout === "combined" &&
      admin?.api !== null &&
      admin?.api !== undefined &&
      admin?.vibe !== null &&
      admin?.vibe !== undefined &&
      admin.api.currency === admin.vibe.currency;

    let vibeRendered = false;

    if (combined && admin?.api && admin.vibe) {
      rows.push(
        combinedBudgetRow({
          api: admin.api,
          vibe: admin.vibe,
          resetFallbackIso: admin.rootResetAtIso ?? chat?.resetAtIso ?? null,
        }),
      );
      vibeRendered = true;
      detailValues.api_usage_percentage = admin.api.usagePercentage.toFixed(6);
      detailValues.api_reset_at =
        admin.api.resetAtIso ?? admin.rootResetAtIso ?? chat?.resetAtIso ?? undefined;
      detailValues.vibe_source = "admin";
      detailValues.vibe_usage_percentage = admin.vibe.usagePercentage.toFixed(6);
      detailValues.vibe_reset_at =
        admin.vibe.resetAtIso ?? admin.rootResetAtIso ?? chat?.resetAtIso ?? undefined;
    } else {
      // Mistral API credits are only reported by the admin billing endpoint. A plan without
      // API credits reports no api_budget: no row, no error.
      if (admin?.api) {
        rows.push(
          budgetRow({
            key: "api",
            label: "API",
            line: admin.api,
            resetFallbackIso: admin.rootResetAtIso ?? chat?.resetAtIso ?? null,
          }),
        );
        detailValues.api_usage_percentage = admin.api.usagePercentage.toFixed(6);
        detailValues.api_reset_at =
          admin.api.resetAtIso ?? admin.rootResetAtIso ?? chat?.resetAtIso ?? undefined;
      } else if (!adminResult.success) {
        errors.push(
          failedAccount(
            MISTRAL_API_LABEL,
            sessionErrorMessage({
              error: adminResult.error,
              sessionExpired: isMistralAdminSessionExpiredError(adminResult),
              source: config.source,
              signInHost: "admin.mistral.ai",
            }),
          ),
        );
      }

      // Mistral Vibe credits: the admin billing budget is preferred (it carries the currency
      // amounts); the chat code usage API backs the row up otherwise.
      if (admin?.vibe) {
        rows.push(
          budgetRow({
            key: "vibe",
            label: "Vibe",
            line: admin.vibe,
            resetFallbackIso: admin.rootResetAtIso ?? chat?.resetAtIso ?? null,
          }),
        );
        vibeRendered = true;
        detailValues.vibe_source = "admin";
        detailValues.vibe_usage_percentage = admin.vibe.usagePercentage.toFixed(6);
        detailValues.vibe_reset_at =
          admin.vibe.resetAtIso ?? admin.rootResetAtIso ?? chat?.resetAtIso ?? undefined;
      } else if (chat) {
        rows.push(chatUsageRow(chat, admin?.rootResetAtIso ?? null));
        vibeRendered = true;
        detailValues.vibe_source = "chat-api";
        detailValues.vibe_usage_percentage = chat.usagePercentage.toFixed(6);
        detailValues.vibe_reset_at = chat.resetAtIso ?? admin?.rootResetAtIso ?? undefined;
      }
    }

    // The PAYG state stays a /quota_status diagnostic, not a panel row.
    detailValues.vibe_payg_enabled = chat ? String(chat.paygEnabled) : undefined;

    // No Vibe data at all: both endpoints failed, or the plan reports no Vibe budget and the
    // chat API is down. Surface the chat error as an invitation.
    if (!vibeRendered && !chatResult.success) {
      errors.push(
        failedAccount(
          MISTRAL_VIBE_LABEL,
          sessionErrorMessage({
            error: chatResult.error,
            sessionExpired: isMistralVibeSessionExpiredError(chatResult),
            source: config.source,
            signInHost: "chat.mistral.ai",
          }),
        ),
      );
    }

    return {
      attempted: true,
      accounts: [{ name: MISTRAL_LABEL, rows, errors: [] }, ...errors],
      debug: [
        ...debug,
        ...statusDetailsFromRecord({
          admin_source: detailValues.admin_source,
          chat_source: detailValues.chat_source,
          api_usage_percentage: detailValues.api_usage_percentage,
          api_reset_at: detailValues.api_reset_at,
          vibe_source: detailValues.vibe_source,
          vibe_usage_percentage: detailValues.vibe_usage_percentage,
          vibe_reset_at: detailValues.vibe_reset_at,
          vibe_payg_enabled: detailValues.vibe_payg_enabled,
          api_budget: admin?.api ? formatBudget(admin.api, admin.api.budget) : undefined,
          api_used: admin?.api ? formatBudget(admin.api, usedAmount(admin.api)) : undefined,
          vibe_budget: admin?.vibe ? formatBudget(admin.vibe, admin.vibe.budget) : undefined,
          vibe_used: admin?.vibe ? formatBudget(admin.vibe, usedAmount(admin.vibe)) : undefined,
        }),
      ],
    };
  },
};

/** A budget amount with its currency code, for /quota_status. */
function formatBudget(line: MistralBudgetLine, amount: number): string {
  return `${accountingDecimalFromNumber(amount)} ${line.currency}`;
}
