import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { AGY_FLAVOR } from "../src/lib/google-agy.js";
import { GEMINI_CLI_AUTH_KEYS, GEMINI_CLI_FLAVOR } from "../src/lib/google-gemini-cli.js";
import { BUNDLED_MAINTAINER_ANNOUNCEMENTS } from "../src/lib/maintainer-announcements.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function section(document: string, start: string, end: string): string {
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return document.slice(startIndex, endIndex);
}

const ORG_ONLY = "Gemini Code Assist Standard or Enterprise (organization) accounts";

describe("Gemini CLI organization-only documentation", () => {
  const readme = read("README.md");
  const providers = read("docs/readme/providers.md");
  const troubleshooting = read("docs/readme/troubleshooting.md");
  const providerSection = section(providers, '<a id="gemini-cli"></a>', '<a id="deepseek"></a>');
  const googleFixes = section(
    troubleshooting,
    "<summary><strong>Google AGY and Gemini CLI</strong></summary>",
    "</details>",
  );

  it("never calls Gemini CLI deprecated or planned for removal", () => {
    for (const document of [readme, providers, troubleshooting]) {
      expect(document).not.toContain("Gemini CLI (deprecated)");
      expect(document).not.toContain("v5.0.0");
      expect(document).not.toContain("Existing setups only");
    }
  });

  it("states organization-only support where the bundled notice does", () => {
    const notice = BUNDLED_MAINTAINER_ANNOUNCEMENTS.find(
      (announcement) => announcement.id === "google-gemini-cli-org-only",
    );
    expect(notice?.message).toContain(ORG_ONLY);
    for (const document of [readme, providerSection, googleFixes]) {
      expect(document).toContain(`Gemini CLI works only with ${ORG_ONLY}.`);
    }
    expect(providerSection).toContain(
      "https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals",
    );
    expect(providerSection).toContain("[Google AGY](#google-agy-quick-setup)");
  });

  it("lists Gemini CLI only in the provider guide's Business / Enterprise table", () => {
    const personal = section(
      providers,
      "<summary><strong>Personal</strong></summary>",
      "</details>",
    );
    const business = section(
      providers,
      "<summary><strong>Business / Enterprise</strong></summary>",
      "</details>",
    );
    expect(personal).not.toContain("Gemini CLI");
    expect(business).toMatch(/\| Gemini CLI +\| \[Needs setup\]\(#gemini-cli\)/);
  });

  it("names the companion, login and project id sources the code reads", () => {
    expect(GEMINI_CLI_FLAVOR.missingCompanionError).toContain("opencode-gemini-auth");
    expect(GEMINI_CLI_AUTH_KEYS).toContain("google");
    for (const document of [providerSection, googleFixes]) {
      expect(document).toContain("opencode-gemini-auth");
      expect(document).toMatch(/opencode auth login google(?![\w-])/);
    }
    for (const source of [
      GEMINI_CLI_FLAVOR.projectIdEnvVar,
      `provider.${GEMINI_CLI_FLAVOR.projectIdConfigProvider}.options.projectId`,
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_PROJECT_ID",
      AGY_FLAVOR.projectIdEnvVar,
      `provider.${AGY_FLAVOR.projectIdConfigProvider}.options.projectId`,
    ]) {
      expect(googleFixes).toContain(`\`${source}\``);
    }
    expect(googleFixes).toContain(`opencode auth login ${AGY_FLAVOR.providerId}`);
  });
});
