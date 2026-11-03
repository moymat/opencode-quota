import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { readMarkdownSection } from "./helpers/markdown-document.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const REGIONS = ["American", "Chinese"] as const;
const PLANS = ["Personal", "Business"] as const;

type Region = (typeof REGIONS)[number];
type Plan = (typeof PLANS)[number];

// For each provider, the plans it is sold on and, per plan, the providers.md anchor of its setup
// step (undefined when it works once you log in).
type ProviderPlans = Map<string, Map<Plan, string | undefined>>;

function readTableCells(line: string): string[] {
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function readTableRows(lines: string[], headerIndex: number): string[][] {
  const rows: string[][] = [];
  for (
    let index = headerIndex + 2;
    index < lines.length && lines[index].startsWith("|");
    index += 1
  ) {
    rows.push(readTableCells(lines[index]));
  }
  return rows;
}

function readPlanLabel(line: string): Plan | undefined {
  const label = line.match(/^<summary><strong>(.+)<\/strong><\/summary>$/)?.[1];
  return PLANS.find((plan) => label?.startsWith(plan));
}

function readGuideProviders(guide: string, region: Region): ProviderPlans {
  const lines = readMarkdownSection(guide, new RegExp(`^${region} providers$`)).split("\n");
  const providers: ProviderPlans = new Map();
  const plansSeen: Plan[] = [];
  let plan: Plan | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    plan = readPlanLabel(lines[index]) ?? plan;
    if (!lines[index].startsWith("| Provider")) continue;

    expect(readTableCells(lines[index])).toEqual([
      "Provider",
      "Auth/setup",
      "Data from",
      "Reports",
    ]);
    if (plan === undefined) throw new Error(`${region} provider table has no plan label`);
    plansSeen.push(plan);

    for (const [provider, authSetup] of readTableRows(lines, index)) {
      const setupAnchor = authSetup.match(/^\[Needs setup\]\(#([^)]+)\)$/)?.[1];
      if (setupAnchor === undefined && authSetup !== "Automatic") {
        throw new Error(`${region} ${plan} ${provider}: unexpected Auth/setup cell ${authSetup}`);
      }
      const plans = providers.get(provider) ?? new Map<Plan, string | undefined>();
      if (plans.has(plan)) {
        throw new Error(`${region} ${plan} table in providers.md lists ${provider} twice`);
      }
      plans.set(plan, setupAnchor);
      providers.set(provider, plans);
    }
  }

  expect(plansSeen, `${region} provider tables in providers.md`).toEqual([...PLANS]);
  return providers;
}

// A README name or plan word that needs one more step is written `[Word](docs/readme/providers.md#anchor)\*`.
function readReadmeWord(cell: string): { word: string; setupAnchor: string | undefined } {
  const link = cell.match(/^\[([^\]]+)\]\(docs\/readme\/providers\.md#([^)]+)\)\\\*$/);
  if (link !== null) return { word: link[1], setupAnchor: link[2] };
  if (/[[\]*\\]/.test(cell)) throw new Error(`README provider cell is not a plain word: ${cell}`);
  return { word: cell, setupAnchor: undefined };
}

type ReadmeProvider = { nameIsLink: boolean; plans: Map<Plan, string | undefined> };

function readReadmeProviders(readme: string, region: Region): Map<string, ReadmeProvider> {
  const lines = readMarkdownSection(readme, /^Providers$/).split("\n");
  const headerIndex = lines.findIndex(
    (line) => line.startsWith("|") && readTableCells(line).join("|") === `${region}|Plans`,
  );
  if (headerIndex === -1) throw new Error(`README "| ${region} | Plans |" table not found`);

  const providers = new Map<string, ReadmeProvider>();
  for (const [nameCell, plansCell] of readTableRows(lines, headerIndex)) {
    const name = readReadmeWord(nameCell);
    const plans = new Map<Plan, string | undefined>();
    for (const planCell of plansCell.split(" · ")) {
      const planWord = readReadmeWord(planCell);
      const plan = PLANS.find((candidate) => candidate === planWord.word);
      if (plan === undefined) throw new Error(`${name.word}: unknown plan ${planCell}`);
      if (name.setupAnchor !== undefined && planWord.setupAnchor !== undefined) {
        throw new Error(`${name.word}: both the name and ${plan} are links`);
      }
      plans.set(plan, name.setupAnchor ?? planWord.setupAnchor);
    }
    expect([...plans.keys()], `${name.word} plans`).toEqual(
      PLANS.filter((plan) => plans.has(plan)),
    );
    if (providers.has(name.word)) {
      throw new Error(`README ${region} table lists ${name.word} twice`);
    }
    providers.set(name.word, { nameIsLink: name.setupAnchor !== undefined, plans });
  }
  return providers;
}

// The README links the name when every plan needs the same step, and otherwise the plan words.
function readmeLinksName(plans: Map<Plan, string | undefined>): boolean {
  const anchors = new Set(plans.values());
  return anchors.size === 1 && !anchors.has(undefined);
}

describe("README provider tables", () => {
  const readme = read("README.md");
  const providerGuide = read("docs/readme/providers.md");

  it.each(REGIONS)("match the %s tables in the provider guide", (region) => {
    const guideProviders = readGuideProviders(providerGuide, region);
    const readmeProviders = readReadmeProviders(readme, region);

    expect([...readmeProviders.keys()].sort()).toEqual([...guideProviders.keys()].sort());
    for (const [provider, plans] of guideProviders) {
      expect(readmeProviders.get(provider)?.plans, provider).toEqual(plans);
      expect(readmeProviders.get(provider)?.nameIsLink, provider).toBe(readmeLinksName(plans));
    }
  });

  it("point every setup link at a section of the provider guide", () => {
    const anchors = new Set(
      Array.from(providerGuide.matchAll(/<a id="([^"]+)"><\/a>/g), (match) => match[1]),
    );
    for (const region of REGIONS) {
      for (const plans of readGuideProviders(providerGuide, region).values()) {
        for (const setupAnchor of plans.values()) {
          if (setupAnchor !== undefined) expect(anchors, setupAnchor).toContain(setupAnchor);
        }
      }
    }
  });

  it("keeps the basic provider guide structure", () => {
    expect(providerGuide).toMatch(/^# Providers$/m);
    expect(providerGuide).toMatch(/^## Custom providers$/m);
    expect(providerGuide).toContain("Ask your agent to add a custom provider");
    expect(providerGuide).toContain("docs/readme/providers.md#custom-providers");
  });
});
