import { formatAccountingQuantity } from "../lib/accounting-format.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type {
  AccountingMetadata,
  AccountingQuantity,
  AccountingUnit,
  QuotaProvider,
  QuotaProviderContext,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import {
  isMistralAdminSessionExpiredError,
  type MistralBudgetLine,
  queryMistralAdminBudget,
} from "../lib/mistral-budget.js";
import {
  isMistralVibeSessionExpiredError,
  type MistralVibeUsage,
  queryMistralVibeUsage,
} from "../lib/mistral-vibe.js";
import {
  DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
  getMistralVibeConfigDiagnosticsCached,
  resolveMistralVibeConfigCached,
} from "../lib/mistral-vibe-config.js";
import { getQuotaProviderRuntimeIds } from "../lib/provider-metadata.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  attemptedErrorResult,
  attemptedResult,
  configStatusDetails,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const MISTRAL_API_LABEL = "Mistral API";
const MISTRAL_VIBE_LABEL = "Mistral Vibe";
const MISTRAL_VIBE_RUNTIME_IDS = new Set(getQuotaProviderRuntimeIds("mistral-vibe"));

const QUOTA_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};

function budgetUnit(line: MistralBudgetLine): AccountingUnit {
  return { kind: "currency", code: line.currency };
}

function budgetQuantity(line: MistralBudgetLine, amount: number): AccountingQuantity {
  return {
    decimal: accountingDecimalFromNumber(amount),
    unit: budgetUnit(line),
  };
}

function usedAmount(line: MistralBudgetLine): number {
  return (line.budget * line.usagePercentage) / 100;
}

/**
 * One budget line as a bar row: remaining percentage, reset countdown, and the
 * typed euro basis (used / limit / remaining) rendered as the summary or
 * detailed facts below the bar.
 */
function budgetLineEntry(params: {
  label: string;
  line: MistralBudgetLine;
  resetFallbackIso: string | null;
}): QuotaToastEntry {
  const { label, line } = params;
  const used = usedAmount(line);
  const remaining = Math.max(0, line.budget - used);
  const resetIso = line.resetAtIso ?? params.resetFallbackIso;

  return {
    accounting: QUOTA_ACCOUNTING,
    name: `${label} Monthly`,
    group: label,
    percentRemaining: 100 - line.usagePercentage,
    ...(resetIso ? { resetTimeIso: resetIso } : {}),
    semantic: {
      metric: { kind: "window", window: "month" },
      prominence: "primary",
    },
    basis: {
      used: {
        quantity: budgetQuantity(line, used),
        authority: "locally_derived",
      },
      limit: {
        quantity: budgetQuantity(line, line.budget),
        authority: "provider_reported",
      },
      remaining: {
        quantity: budgetQuantity(line, remaining),
        authority: "locally_derived",
      },
    },
    sortPriority: 0,
  };
}

/** Vibe bar row from the chat code usage API, which reports no euro amounts. */
function chatUsageEntry(usage: MistralVibeUsage, resetFallbackIso: string | null): QuotaToastEntry {
  const resetIso = usage.resetAtIso ?? resetFallbackIso;
  return {
    accounting: QUOTA_ACCOUNTING,
    name: `${MISTRAL_VIBE_LABEL} Monthly`,
    group: MISTRAL_VIBE_LABEL,
    percentRemaining: 100 - usage.usagePercentage,
    ...(resetIso ? { resetTimeIso: resetIso } : {}),
    semantic: {
      metric: { kind: "window", window: "month" },
      prominence: "primary",
    },
    sortPriority: 0,
  };
}

/**
 * A rejected session (rotation or revocation) falls through to the next
 * candidate, e.g. the browser's current cookie after an env cookie died.
 */
async function queryWithAlternates<TResult extends { success: boolean }>(
  query: (cookie: string, options: { requestTimeoutMs?: number }) => Promise<TResult>,
  isSessionExpired: (result: TResult) => boolean,
  candidates: string[],
  requestTimeoutMs: number | undefined,
): Promise<TResult> {
  let result = await query(candidates[0], { requestTimeoutMs });
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

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveMistralVibeConfigCached({
      maxAgeMs: DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
      source: ctx.config?.mistralVibeCookieSource,
    });
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.trim().toLowerCase().split("/", 2);
    return MISTRAL_VIBE_RUNTIME_IDS.has(provider);
  },

  async fetch(ctx: QuotaProviderContext) {
    const source = ctx.config?.mistralVibeCookieSource;
    const diagnostics = await getMistralVibeConfigDiagnosticsCached({
      maxAgeMs: DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
    });
    const statusDetails = [
      ...configStatusDetails({
        ...diagnostics,
        error: diagnostics.error
          ? sanitizeSingleLineDisplaySnippet(diagnostics.error, 120)
          : undefined,
      }),
      ...statusDetailsFromRecord({
        zen_browser_profile: diagnostics.zenBrowserProfile ?? undefined,
        zen_browser_cookies:
          diagnostics.zenBrowserCookiesFound === null
            ? undefined
            : String(diagnostics.zenBrowserCookiesFound),
        zen_browser_error: diagnostics.zenBrowserError ?? undefined,
      }),
    ];
    const config = await resolveMistralVibeConfigCached({
      maxAgeMs: DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
      source,
    });

    if (config.state === "none") {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }
    if (config.state === "invalid") {
      return withStatusDetails(
        attemptedErrorResult(
          MISTRAL_VIBE_LABEL,
          `Invalid config (${config.source}): ${config.error}`,
        ),
        statusDetails,
      );
    }

    const requestTimeoutMs = ctx.config?.requestTimeoutMsConfigured
      ? ctx.config.requestTimeoutMs
      : undefined;
    const candidates = [config.config.cookie, ...(config.config.alternates ?? [])];
    // The admin billing endpoint and the chat code usage API share the same
    // session cookie; both are queried so either can back the Vibe line up.
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

    const entries: QuotaToastEntry[] = [];
    const errors: QuotaToastError[] = [];
    const detailValues: Record<string, string | undefined> = {
      admin_source: adminResult.success ? "ok" : "failed",
      chat_source: chatResult.success ? "ok" : "failed",
    };

    // Mistral API credits are only reported by the admin billing endpoint. A
    // plan without API credits reports no api_budget: no line, no error.
    if (admin?.api) {
      entries.push(
        budgetLineEntry({
          label: MISTRAL_API_LABEL,
          line: admin.api,
          resetFallbackIso: admin.rootResetAtIso ?? chat?.resetAtIso ?? null,
        }),
      );
      detailValues.api_usage_percentage = admin.api.usagePercentage.toFixed(6);
      detailValues.api_reset_at =
        admin.api.resetAtIso ?? admin.rootResetAtIso ?? chat?.resetAtIso ?? undefined;
    } else if (!adminResult.success) {
      errors.push({
        label: MISTRAL_API_LABEL,
        message: sessionErrorMessage({
          error: adminResult.error,
          sessionExpired: isMistralAdminSessionExpiredError(adminResult),
          source: config.source,
          signInHost: "admin.mistral.ai",
        }),
      });
    }

    // Mistral Vibe credits: the admin billing budget is preferred (it carries
    // the euro amounts); the chat code usage API backs the line up otherwise.
    let vibeRendered = false;
    if (admin?.vibe) {
      entries.push(
        budgetLineEntry({
          label: MISTRAL_VIBE_LABEL,
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
      entries.push(chatUsageEntry(chat, admin?.rootResetAtIso ?? null));
      vibeRendered = true;
      detailValues.vibe_source = "chat-api";
      detailValues.vibe_usage_percentage = chat.usagePercentage.toFixed(6);
      detailValues.vibe_reset_at = chat.resetAtIso ?? admin?.rootResetAtIso ?? undefined;
    }

    // The PAYG state stays a /quota_status diagnostic, not a panel row.
    detailValues.vibe_payg_enabled = chat ? String(chat.paygEnabled) : undefined;

    // No Vibe data at all: both endpoints failed, or the plan reports no Vibe
    // budget and the chat API is down. Surface the chat error as an invitation.
    if (!vibeRendered && !chatResult.success) {
      errors.push({
        label: MISTRAL_VIBE_LABEL,
        message: sessionErrorMessage({
          error: chatResult.error,
          sessionExpired: isMistralVibeSessionExpiredError(chatResult),
          source: config.source,
          signInHost: "chat.mistral.ai",
        }),
      });
    }

    const rawDetails = statusDetailsFromRecord({
      api_budget: admin?.api
        ? formatAccountingQuantity(budgetQuantity(admin.api, admin.api.budget))
        : undefined,
      api_used: admin?.api
        ? formatAccountingQuantity(budgetQuantity(admin.api, usedAmount(admin.api)))
        : undefined,
      vibe_budget: admin?.vibe
        ? formatAccountingQuantity(budgetQuantity(admin.vibe, admin.vibe.budget))
        : undefined,
      vibe_used: admin?.vibe
        ? formatAccountingQuantity(budgetQuantity(admin.vibe, usedAmount(admin.vibe)))
        : undefined,
    });

    return withStatusDetails(
      {
        ...attemptedResult(entries, errors),
        ...(rawDetails.length > 0 ? { rawDetails } : {}),
      },
      [...statusDetails, ...statusDetailsFromRecord(detailValues)],
    );
  },
};
