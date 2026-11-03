import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vite-plus/test";

import { customRowPrefix } from "../src/core/provider-source.js";
import { buildQuotaExportFromSnapshot, exportProviderFromCheck } from "../src/lib/quota-export.js";
import { QUOTA_PROVIDER_MAX_BODY_BYTES } from "../src/lib/quota-providers-remote.js";
import {
  CUSTOM_RESULT_TYPES,
  JSON_V1_MAX_ITEMS,
  JSON_V1_MAX_NUMBER_MAGNITUDE,
  QUOTA_PROVIDER_REMOTE_FORMATS,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  validateQuotaProviders,
} from "../src/lib/quota-providers.js";
import { percentRow, providerSnapshot, quotaRow } from "./helpers/fake-answers.js";
import {
  hasMarkdownLinkTo,
  readFencedCodeBlocks,
  readMarkdownParagraphContaining,
  readMarkdownSection,
} from "./helpers/markdown-document.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const GUIDES = [
  "README.md",
  "docs/readme/configuration.md",
  "docs/readme/providers.md",
  "docs/readme/troubleshooting.md",
  "docs/readme/external-integration.md",
  "docs/readme/updating.md",
];

/** GitHub's id for a heading: lower case, punctuation dropped, spaces as hyphens. */
function headingAnchor(heading: string): string {
  return heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

function documentAnchors(document: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of document.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    anchors.add(headingAnchor(match[1]));
  }
  for (const match of document.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(match[1]);
  return anchors;
}

/** The body rows of the markdown table whose header row starts with `firstHeaderCell`. */
function readTable(document: string, firstHeaderCell: string): string[][] {
  const lines = document.split("\n");
  const headerIndex = lines.findIndex((line) => line.startsWith(`| ${firstHeaderCell} `));
  if (headerIndex === -1) throw new Error(`Table not found: ${firstHeaderCell}`);
  const rows: string[][] = [];
  for (let index = headerIndex + 2; index < lines.length && lines[index].startsWith("|"); index++) {
    rows.push(
      lines[index]
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

const codeWords = (cell: string) => Array.from(cell.matchAll(/`([^`]+)`/g), (match) => match[1]);

/** A json-v1 definition with one mapping, for asking the validator what it accepts. */
function acceptsJsonV1(adapter: unknown): boolean {
  return (
    validateQuotaProviders([
      {
        id: "docs-check",
        mode: "remote-api",
        url: "https://quota.example/v1/usage",
        format: "json-v1",
        adapter,
      },
    ]).issues.length === 0
  );
}

const acceptsMapping = (resultType: string, metric: object) =>
  acceptsJsonV1({ mappings: [{ resultType, name: "Row", metric }] });

const path = (name: string) => ({ path: [name] });

/** Each metric type of the compatibility table but `value`, with the sources it needs. */
const METRICS: Record<string, object> = {
  percentage: { type: "percentage", percentage: path("percent"), meaning: "remaining" },
  "used-limit": { type: "used-limit", used: path("used"), limit: path("limit") },
  "remaining-limit": {
    type: "remaining-limit",
    remaining: path("remaining"),
    limit: path("limit"),
  },
  "spend-budget": { type: "spend-budget", spend: path("spend"), budget: path("budget") },
  "remaining-budget": {
    type: "remaining-budget",
    remaining: path("remaining"),
    budget: path("budget"),
  },
  status: { type: "status", value: path("status") },
};

describe("README", () => {
  const readme = read("README.md");

  it("sends custom providers to the agent and the provider guide", () => {
    expect(readMarkdownSection(readme, /^Commands$/)).not.toContain("provider add");
    const customProviders = readMarkdownSection(readme, /^Custom providers$/);
    expect(customProviders).toContain("Ask your agent to add a custom provider");
    expect(hasMarkdownLinkTo(customProviders, "docs/readme/providers.md#custom-providers")).toBe(
      true,
    );
  });

  it("links to the authoritative external references", () => {
    const referenceSection = readMarkdownSection(readme, /^Reference$/);

    for (const url of [
      "https://opencode.ai/docs/",
      "https://opencode.ai/docs/config/",
      "https://opencode.ai/docs/plugins/",
      "https://opencode.ai/docs/tui/",
      "https://models.dev/",
      "https://nodejs.org/en/download",
    ]) {
      expect(hasMarkdownLinkTo(referenceSection, url), url).toBe(true);
    }
  });
});

describe("user guides", () => {
  it("have every page and heading the plugin links to", () => {
    const sources = readdirSync(new URL("../src", import.meta.url), { recursive: true })
      .map(String)
      .filter((file) => /\.tsx?$/.test(file));
    const links = sources.flatMap((file) =>
      Array.from(
        read(`src/${file}`).matchAll(
          /https:\/\/github\.com\/slkiser\/opencode-quota\/blob\/main\/(docs\/readme\/[\w.-]+\.md)(?:#([\w-]+))?/g,
        ),
        (match) => ({ file, page: match[1], anchor: match[2] }),
      ),
    );
    expect(links.map((link) => `${link.page}#${link.anchor ?? ""}`)).toEqual(
      expect.arrayContaining([
        "docs/readme/configuration.md#",
        "docs/readme/providers.md#custom-providers",
      ]),
    );

    for (const link of links) {
      expect(existsSync(new URL(`../${link.page}`, import.meta.url)), link.file).toBe(true);
      if (link.anchor === undefined) continue;
      expect(
        documentAnchors(read(link.page)),
        `${link.file}: ${link.page}#${link.anchor}`,
      ).toContain(link.anchor);
    }
  });

  it("use no retired names and never promise that a switched-off key is not read", () => {
    for (const guide of GUIDES) {
      const document = read(guide);
      for (const retired of ["accounting-v1", "quotaProviders", "custom-sources"]) {
        expect(document, `${guide}: ${retired}`).not.toContain(retired);
      }
      // Keys are still read on this computer to hide them from agent answers; only sending stops.
      expect(document, guide).not.toMatch(/key is never read|nothing reads its key/);
    }
    for (const guide of ["README.md", "docs/readme/configuration.md"]) {
      expect(read(guide), guide).not.toContain("experimental.quotaToast");
    }
  });
});

describe("provider guide: custom providers", () => {
  const section = readMarkdownSection(read("docs/readme/providers.md"), /^Custom providers$/);
  const blocks = readFencedCodeBlocks(section);

  it("has examples the validator accepts", () => {
    const definitionLists = blocks
      .filter((block) => block.info === "jsonc")
      .map((block) => parseJsonc(block.content) as { providers?: { custom?: unknown[] } })
      .map((settings) => settings.providers?.custom)
      .filter((custom) => custom !== undefined);
    expect(definitionLists.length).toBeGreaterThanOrEqual(2);
    for (const custom of definitionLists) {
      const result = validateQuotaProviders(custom);
      expect(result.issues).toEqual([]);
      expect(result.value).toHaveLength(custom.length);
    }

    const adapters = blocks
      .filter((block) => block.info === "json")
      .map((block) => JSON.parse(block.content) as Record<string, unknown>)
      .filter((value) => "mappings" in value);
    expect(adapters).toHaveLength(1);
    expect(acceptsJsonV1(adapters[0])).toBe(true);
  });

  it("names only agent tools the plugin has", () => {
    const agentTools = read("src/agent-tools.ts");
    const named = new Set(Array.from(section.matchAll(/\bquota_provider_[a-z]+/g), (m) => m[0]));
    expect(named.size).toBeGreaterThan(0);
    for (const tool of named) expect(agentTools, tool).toContain(`"${tool}"`);
  });

  it("lists the remote formats and limits the code uses", () => {
    for (const format of QUOTA_PROVIDER_REMOTE_FORMATS) expect(section).toContain(`\`${format}\``);
    expect(section).toContain(`limited to ${QUOTA_PROVIDER_MAX_BODY_BYTES / 1024} KiB`);
    expect(section).toContain(`A list holds 1–${JSON_V1_MAX_ITEMS} items`);
    expect(JSON_V1_MAX_NUMBER_MAGNITUDE).toBe(1e15);
    expect(section).toContain("absolute magnitude at most `1e15`");
  });

  it("allows each metric type exactly the result types the validator accepts", () => {
    const rows = readTable(section, "`metric.type`");
    expect(rows.map(([type]) => codeWords(type)[0]).sort()).toEqual(
      [...Object.keys(METRICS), "value"].sort(),
    );
    for (const [typeCell, allowedCell] of rows) {
      const type = codeWords(typeCell)[0];
      if (type === "value") continue;
      const allowed = codeWords(allowedCell);
      for (const resultType of CUSTOM_RESULT_TYPES) {
        expect(acceptsMapping(resultType, METRICS[type]), `${type} as ${resultType}`).toBe(
          allowed.includes(resultType),
        );
      }
    }
  });

  it("allows each value type exactly the result types the validator accepts", () => {
    const rows = readTable(section, "`valueType`");
    expect(rows.length).toBeGreaterThan(0);
    for (const [valueTypeCell, allowedCell] of rows) {
      const valueType = codeWords(valueTypeCell)[0];
      const allowed = codeWords(allowedCell);
      const metric = { type: "value", valueType, value: path("value") };
      for (const resultType of CUSTOM_RESULT_TYPES) {
        expect(acceptsMapping(resultType, metric), `${valueType} as ${resultType}`).toBe(
          allowed.includes(resultType),
        );
      }
    }
  });
});

describe("external integration guide", () => {
  const external = read("docs/readme/external-integration.md");
  const jsonBasics = readMarkdownSection(external, /^JSON basics$/);
  const nowMs = Date.parse("2026-10-01T12:00:00.000Z");

  /** The export document of one Copilot account with a percent row and a value row. */
  function copilotExport() {
    return buildQuotaExportFromSnapshot(
      {
        version: 6,
        providers: [
          providerSnapshot(
            "copilot",
            "Copilot",
            [
              quotaRow("copilot.allowance", {
                label: "Premium requests",
                account: "pro",
                window: "month",
                resetsAt: "2026-11-01T00:00:00.000Z",
                percentRemaining: 62.3,
              }),
              quotaRow("copilot.spend", { label: "Spend", type: "usage", text: "$12.50" }),
            ],
            { checkedAtMs: nowMs - 42_000 },
          ),
        ],
        resetNotices: [],
        generatedAtMs: nowMs,
        serverId: "test",
        revision: 1,
      },
      nowMs,
    );
  }

  it("shows the export document's fields and version", () => {
    const actual = copilotExport();
    const exampleBlock = readFencedCodeBlocks(external).find(
      (block) => block.info === "json" && block.content.includes('"version"'),
    );
    if (exampleBlock === undefined) throw new Error("Small JSON example not found");
    const example = JSON.parse(exampleBlock.content) as typeof actual;

    expect(jsonBasics).toContain(`JSON schema version \`${actual.version}\``);
    expect(example.version).toBe(actual.version);
    expect(Object.keys(example).sort()).toEqual(Object.keys(actual).sort());
    const exampleProvider = example.providers.copilot;
    const actualProvider = actual.providers.copilot;
    expect(Object.keys(exampleProvider).sort()).toEqual(Object.keys(actualProvider).sort());
    if (exampleProvider.status !== "ok" || actualProvider.status !== "ok") {
      throw new Error("Copilot is not ok");
    }
    const actualPercentEntry = actualProvider.entries.find(
      (entry) => entry.renderType === "percent",
    );
    if (actualPercentEntry === undefined) throw new Error("No percent entry");
    const optional = new Set(["window", "resetAt"]);
    expect(Object.keys(exampleProvider.entries[0]).sort()).toEqual(
      Object.keys(actualPercentEntry)
        .filter((key) => !optional.has(key))
        .sort(),
    );
  });

  it("names every entry field the export writes", () => {
    const actual = copilotExport().providers.copilot;
    if (actual.status !== "ok") throw new Error("Copilot is not ok");
    const written = new Set(actual.entries.flatMap((entry) => Object.keys(entry)));

    const required = readTable(jsonBasics, "Field").map(([field]) => codeWords(field)[0]);
    // "Optional entry fields are `account` (…), `window` (…) and `resetAt` (…)."
    const optional = Array.from(
      readMarkdownParagraphContaining(jsonBasics, "Optional entry fields are").matchAll(
        /`(\w+)` \(/g,
      ),
      (match) => match[1],
    );
    const kinds = ["renderType", "percentRemaining", "value"];
    expect([...required, ...optional, ...kinds].sort()).toEqual([...written].sort());
  });

  it("names the custom provider rows and source summaries as the export writes them", () => {
    expect(jsonBasics).toContain(`providers["${QUOTA_PROVIDERS_AGGREGATE_ID}"]`);
    expect(jsonBasics).toContain(`\`${customRowPrefix("<definition id>")}<key>\``);

    const definitions = validateQuotaProviders([
      { id: "on", mode: "remote-api", url: "https://on.example/q", format: "quota-v1" },
      {
        id: "off",
        mode: "remote-api",
        url: "https://off.example/q",
        format: "quota-v1",
        enabled: false,
      },
    ]).value;
    if (definitions === undefined) throw new Error("Definitions rejected");
    const part = exportProviderFromCheck({
      providerId: QUOTA_PROVIDERS_AGGREGATE_ID,
      label: "Custom providers",
      rows: [],
      checkedAtMs: nowMs,
      customDefinitions: definitions,
      accounts: [{ name: "On", login: "on", rows: [percentRow("Daily", "Daily", 40)], errors: [] }],
    });
    const [on, off] = part.sources ?? [];
    const summary = readMarkdownParagraphContaining(jsonBasics, "`sources`");
    for (const key of Object.keys(on)) expect(summary).toContain(`\`${key}\``);
    expect(off).toMatchObject({ enabled: false, entryCount: 0 });
    expect(summary).toContain('`"enabled": false` instead of a `status`');
  });

  it("lists the --threshold exit codes", () => {
    const rows = readTable(external, "Code");
    expect(rows.map(([code]) => codeWords(code)[0])).toEqual(["0", "1", "2"]);
    expect(rows[1][1]).toContain("below the threshold");
    expect(rows[2][1]).toContain("incomplete");
  });

  it("selects rows by renderType in every copy-paste filter, never by position", () => {
    const filters = readFencedCodeBlocks(external).filter((block) => block.content.includes("jq "));
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) {
      expect(filter.content).toContain('renderType==\\"percent\\"');
      expect(filter.content).not.toMatch(/entries\[\d+\]/);
    }
  });
});
