import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaToastEntry,
} from "../lib/entries.js";
import { isMistralVibeSessionExpiredError, queryMistralVibeUsage } from "../lib/mistral-vibe.js";
import {
  DEFAULT_MISTRAL_VIBE_CONFIG_CACHE_MAX_AGE_MS,
  getMistralVibeConfigDiagnosticsCached,
  resolveMistralVibeConfigCached,
} from "../lib/mistral-vibe-config.js";
import { getQuotaProviderRuntimeIds } from "../lib/provider-metadata.js";
import {
  attemptedErrorResult,
  attemptedResult,
  configStatusDetails,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const MISTRAL_VIBE_LABEL = "Mistral Vibe";
const MISTRAL_VIBE_RUNTIME_IDS = new Set(getQuotaProviderRuntimeIds("mistral-vibe"));

const QUOTA_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};
const STATUS_ACCOUNTING: AccountingMetadata = {
  resultType: "status",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};

function buildEntries(usage: {
  usagePercentage: number;
  paygEnabled: boolean;
  resetAtIso: string | null;
}): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [
    {
      accounting: QUOTA_ACCOUNTING,
      name: `${MISTRAL_VIBE_LABEL} Monthly`,
      group: MISTRAL_VIBE_LABEL,
      percentRemaining: 100 - usage.usagePercentage,
      ...(usage.resetAtIso ? { resetTimeIso: usage.resetAtIso } : {}),
      semantic: {
        metric: { kind: "window", window: "month" },
        prominence: "primary",
      },
    },
  ];

  entries.push({
    accounting: STATUS_ACCOUNTING,
    kind: "boolean",
    name: "mistral-vibe-payg",
    group: MISTRAL_VIBE_LABEL,
    semantic: {
      metric: { kind: "named", name: "Pay-as-you-go" },
      prominence: "supplementary",
    },
    value: usage.paygEnabled,
  });

  return entries;
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
    let result = await queryMistralVibeUsage(candidates[0], { requestTimeoutMs });
    // A rejected session (rotation or revocation) falls through to the next
    // candidate, e.g. the browser's current cookie after an env cookie died.
    for (const alternate of candidates.slice(1)) {
      if (result.success || !isMistralVibeSessionExpiredError(result)) break;
      result = await queryMistralVibeUsage(alternate, { requestTimeoutMs });
    }

    if (!result.success) {
      const message = isMistralVibeSessionExpiredError(result)
        ? config.source.startsWith("zen-browser:")
          ? `${result.error} Sign in again at chat.mistral.ai in Zen browser.`
          : result.error
        : result.error;
      return withStatusDetails(attemptedErrorResult(MISTRAL_VIBE_LABEL, message), statusDetails);
    }

    return withStatusDetails(attemptedResult(buildEntries(result.data)), [
      ...statusDetails,
      ...statusDetailsFromRecord({
        usage_percentage: result.data.usagePercentage.toFixed(6),
        payg_enabled: String(result.data.paygEnabled),
        reset_at: result.data.resetAtIso ?? undefined,
      }),
    ]);
  },
};
