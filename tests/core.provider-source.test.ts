import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readSavedState } from "../src/core/persist.js";
import { keyedLogins, loadProviderSource, providerContext } from "../src/core/provider-source.js";
import { createQuotaStore } from "../src/core/store.js";
import type { QuotaProvider } from "../src/lib/entries.js";
import { buildQuotaExportFromSnapshot } from "../src/lib/quota-export.js";
import {
  __resetResolvedAuthIdentityForTests,
  deriveResolvedAuthIdentity,
  getResolvedAuthIdentityKeyPath,
} from "../src/lib/resolved-auth-identity.js";
import type { ProviderFetchResult } from "../src/providers/contract.js";
import { minimaxChinaCodingPlanProvider } from "../src/providers/minimax-coding-plan.js";
import { defaultSettings } from "../src/settings/index.js";
import { answer, percentRow, quotaRow } from "./helpers/fake-answers.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";

const runtime = useOpencodeFolders();
/** The registered providers every host below names. */
const registry = { providers: [] as QuotaProvider[] };

const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";
const EMAIL = "alice@example.com";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A provider that is always available and answers with `fetch`. */
function fakeProvider(id: string, fetch: () => Promise<ProviderFetchResult>): QuotaProvider {
  return { id, cachePolicy: { kind: "account-neutral" }, isAvailable: async () => true, fetch };
}

/** A store over `provider` with the default settings, saving to this test's snapshot file. */
function storeFor(provider: QuotaProvider) {
  registry.providers = [provider];
  const loaded = {
    path: "settings.jsonc",
    exists: true,
    settings: defaultSettings(),
    issues: [],
    fromFile: [],
    notRead: [],
  };
  const host = {
    client: {} as never,
    workspaceRoot: runtime.root,
    locationDirectory: runtime.root,
    settings: () => loaded,
    providers: () => registry.providers,
  };
  return createQuotaStore({
    source: () => loadProviderSource(host),
    file: join(runtime.root, "state", "snapshot-v6.json"),
    log: () => {},
  });
}

/** One Copilot login on the "pro" plan with its premium requests left. */
function copilotPlan(login: string, percentRemaining: number) {
  return {
    name: "Copilot (pro)",
    login,
    rows: [percentRow("allowance", "Premium requests", percentRemaining, { window: "month" })],
  };
}

describe("provider source logins", () => {
  beforeEach(() => {
    __resetResolvedAuthIdentityForTests();
  });

  afterEach(() => {
    __resetResolvedAuthIdentityForTests();
  });

  it("checks found and later registered providers unless their id is switched off", async () => {
    const first = fakeProvider("copilot", async () => answer());
    const later = fakeProvider("future-provider", async () => answer());
    registry.providers = [first];
    const loaded = {
      path: "settings.jsonc",
      exists: true,
      settings: defaultSettings(),
      issues: [],
      fromFile: [],
      notRead: [],
    };
    const host = {
      client: {} as never,
      workspaceRoot: runtime.root,
      locationDirectory: runtime.root,
      settings: () => loaded,
      providers: () => registry.providers,
    };
    expect((await loadProviderSource(host)).providers.map(({ id }) => id)).toEqual(["copilot"]);
    loaded.settings.providers.off = ["copilot"];
    registry.providers = [first, later];
    expect((await loadProviderSource(host)).providers.map(({ id }) => id)).toEqual([
      "future-provider",
    ]);
    expect(providerContext(host).config.automaticDiscovery).toBe(true);
  });

  it.each([
    { runtimeId: "minimax", expected: [] },
    { runtimeId: "minimax-china-coding-plan", expected: ["minimax-china-coding-plan"] },
  ])(
    "discovers and matches MiniMax China with default settings for $runtimeId",
    async ({ runtimeId, expected }) => {
      vi.stubEnv("MINIMAX_CHINA_CODING_PLAN_API_KEY", "china-key");
      registry.providers = [minimaxChinaCodingPlanProvider];
      const loaded = {
        path: "settings.jsonc",
        exists: true,
        settings: defaultSettings(),
        issues: [],
        fromFile: [],
        notRead: [],
      };
      const host = {
        client: {
          config: { providers: async () => ({ data: { providers: [{ id: runtimeId }] } }) },
        },
        workspaceRoot: runtime.root,
        locationDirectory: runtime.root,
        settings: () => loaded,
        providers: () => registry.providers,
      };

      const source = await loadProviderSource(host);

      expect(loaded.settings.providers.off).toEqual([]);
      expect(source.providers.map(({ id }) => id)).toEqual(expected);
      expect(source.providerIdsForModel?.({ id: "MiniMax-M2.7", providerID: runtimeId })).toEqual(
        expected,
      );
      expect(source.providerIdsForModel?.({ id: `${runtimeId}/MiniMax-M2.7` })).toEqual(expected);
    },
  );

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "keys logins with the install's protected key, so a saved login can't be matched to an email",
    async () => {
      const [login, none] = await keyedLogins("google-gemini-cli", [EMAIL, ""]);
      expect(none).toBe("");
      expect(login).not.toContain("alice");
      expect(await keyedLogins("google-gemini-cli", [EMAIL])).toEqual([login]);
      expect(await keyedLogins("google-agy", [EMAIL])).not.toEqual([login]);

      // The store saves a hash of the keyed id, never one anyone can recompute from an email.
      const row = quotaRow("google-gemini-cli.pro", {
        label: "Pro",
        window: "day",
        percentRemaining: 50,
      });
      const file = join(runtime.root, "state", "snapshot-v6.json");
      const store = createQuotaStore({
        source: async () => ({
          providers: [
            {
              id: "google-gemini-cli",
              label: "Gemini CLI",
              identity: async () => ({ key: "account", persist: true }),
              fetch: async () => ({ rows: [row], rowLogins: [login ?? ""], debug: [] }),
            },
          ],
          minIntervalMs: 0,
        }),
        file,
        log: () => {},
      });
      await store.refresh({ reason: "manual" });
      await store.dispose();
      const saved = await readFile(file, "utf8");
      expect(saved).not.toContain(sha256(EMAIL).slice(0, 16));
      expect(saved).not.toContain("alice");

      // Another install (another key) gets other ids.
      await rm(join(runtime.root, "state"), { recursive: true, force: true });
      __resetResolvedAuthIdentityForTests();
      expect(await keyedLogins("google-gemini-cli", [EMAIL])).not.toEqual([login]);
    },
  );
});

describe("export of a check and of the saved snapshot", () => {
  afterEach(() => {
    registry.providers = [];
  });

  /** `provider`'s part of the export after a check, and after a restart reads the file. */
  async function checkThenReload(provider: QuotaProvider) {
    const nowMs = Date.now();
    const checking = storeFor(provider);
    const checked = await checking.refresh({ reason: "manual" });
    await checking.dispose();
    const reading = storeFor(provider);
    const reloaded = await reading.snapshot({ refresh: false });
    await reading.dispose();
    return [checked, reloaded].map(
      (snapshot) => buildQuotaExportFromSnapshot(snapshot, nowMs).providers[provider.id],
    );
  }

  it("shows the provider's last failure, not its kept rows, until a check works again", async () => {
    const left = (percentRemaining: number) =>
      answer({
        name: "Claude",
        rows: [percentRow("weekly", "Weekly", percentRemaining, { window: "week" })],
      });
    const answers: ProviderFetchResult[] = [
      left(80),
      answer({ name: "Claude", errors: ["HTTP 503"] }),
      left(70),
    ];
    const store = storeFor(
      fakeProvider("anthropic", async () => answers.shift() as ProviderFetchResult),
    );
    const checkThenExport = async () => {
      const snapshot = await store.refresh({ reason: "manual" });
      return buildQuotaExportFromSnapshot(snapshot).providers.anthropic;
    };

    expect(await checkThenExport()).toMatchObject({
      status: "ok",
      entries: [{ name: "Anthropic Weekly", window: "Weekly", percentRemaining: 80 }],
    });
    expect(await checkThenExport()).toMatchObject({
      status: "error",
      error: "Provider error 503",
    });
    expect(await checkThenExport()).toMatchObject({
      status: "ok",
      entries: [{ percentRemaining: 70 }],
    });
    await store.dispose();

    // The part stays in memory: the snapshot file, which the terminal command reads, has rows.
    const saved = await readFile(join(runtime.root, "state", "snapshot-v6.json"), "utf8");
    expect(saved).not.toContain("exportPart");
  });

  it("numbers two accounts with one name alike in the check's export and after a reload", async () => {
    const [checked, reloaded] = await checkThenReload(
      fakeProvider("copilot", async () =>
        answer(copilotPlan("alice-id", 80), copilotPlan("bob-id", 40)),
      ),
    );

    expect(reloaded).toEqual(checked);
    const entries = checked?.status === "ok" ? checked.entries : [];
    expect(entries.map((entry) => entry.id)).toEqual(["copilot.allowance", "copilot.allowance"]);
    expect(new Set(entries.map((entry) => entry.account))).toEqual(new Set(["pro", "pro 2"]));
    expect(new Set(entries.map((entry) => entry.name))).toEqual(
      new Set(["Copilot (pro) Premium requests", "Copilot (pro 2) Premium requests"]),
    );
  });

  it("keeps an account's number in the check's export while the other login fails", async () => {
    const answers = [answer(copilotPlan("alice-id", 80), copilotPlan("bob-id", 40))];
    const store = storeFor(
      fakeProvider("copilot", async () => answers.shift() as ProviderFetchResult),
    );
    const checkThenExport = async () => {
      const snapshot = await store.refresh({ reason: "manual" });
      const part = buildQuotaExportFromSnapshot(snapshot).providers.copilot;
      return part?.status === "ok" || part?.status === "partial" ? part.entries : [];
    };

    const first = await checkThenExport();
    // The login numbered "pro 2" answers again; the other one fails, so its rows are kept.
    const second = first.find((entry) => entry.account === "pro 2");
    const secondLogin =
      second?.renderType === "percent" && second.percentRemaining === 80 ? "alice-id" : "bob-id";
    const otherLogin = secondLogin === "alice-id" ? "bob-id" : "alice-id";
    answers.push(
      answer(
        { name: "Copilot (pro)", login: otherLogin, errors: ["HTTP 503"] },
        copilotPlan(secondLogin, 5),
      ),
    );
    const failed = await checkThenExport();
    await store.dispose();

    expect(failed).toEqual([{ ...second, percentRemaining: 5 }]);
  });

  it("writes a check that reported nothing as the same error after a reload", async () => {
    const [checked, reloaded] = await checkThenReload(
      fakeProvider("anthropic", async () => answer({ name: "Claude" })),
    );

    expect(checked).toMatchObject({ status: "error", error: "Nothing reported" });
    expect(reloaded).toEqual(checked);
  });
});

describe("a resolved-auth login on Windows", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    __resetResolvedAuthIdentityForTests();
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    __resetResolvedAuthIdentityForTests();
    registry.providers = [];
  });

  it("is told apart by an in-memory key: a poll within the interval is answered from memory, and only the last check is saved", async () => {
    const login = { token: "token-one" };
    const fetch = vi.fn(async () =>
      answer({ name: "Z.ai", rows: [percentRow("weekly", "Weekly", 60, { window: "week" })] }),
    );
    const store = storeFor({
      id: "zai",
      cachePolicy: {
        kind: "resolved-auth",
        resolveIdentity: async () =>
          deriveResolvedAuthIdentity({
            providerId: "zai",
            principal: { kind: "credential", value: login.token },
          }),
      },
      isAvailable: async () => true,
      fetch,
    });

    await store.refresh({ reason: "poll" });
    const second = await store.refresh({ reason: "poll" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.providers[0]?.rows).toHaveLength(1);

    // Another account is checked at once, not answered with the first one's rows.
    login.token = "token-two";
    await store.refresh({ reason: "poll" });
    expect(fetch).toHaveBeenCalledTimes(2);
    await store.dispose();

    const saved = await readSavedState(join(runtime.root, "state", "snapshot-v6.json"));
    expect(saved.entries.size).toBe(0);
    expect(saved.lastChecks.get("zai")).toMatchObject({ failures: 0 });
    await expect(readFile(getResolvedAuthIdentityKeyPath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
