/**
 * Guards `docs/catalogue.md`, the page a person reads before installing anything (T091).
 *
 * `pnpm docs:check` already fails the gate when the committed file has drifted from what the emitter
 * produces, so staleness is covered and is not retested here. What that check cannot notice is the
 * emitter agreeing with itself about something wrong: a table of contents pointing at anchors that do
 * not exist, an entry omitted from both the body and the index, or a branch that has never run because
 * no shipped pattern reaches it.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { render } from "../../scripts/emit-docs.js";
import { loadCatalog } from "../../src/engine/catalog/load.js";

const page = await render();
const catalog = await loadCatalog();

/** Every `### name` on the page, which is the anchor set a link can resolve against. */
const headings = new Set([...page.matchAll(/^### (.+)$/gmu)].map((match) => match[1]));

describe("the catalogue page", () => {
  it("has a section for every pattern, and a pattern for every section", () => {
    // Both directions, because they fail differently and both are silent. A pattern with no section is
    // a reader concluding the catalogue does not hold what it holds; a section for a pattern that no
    // longer exists is worse, since they would install and find nothing.
    expect([...headings].toSorted()).toEqual(
      catalog.patterns.map((pattern) => pattern.name).toSorted(),
    );
  });

  it("links only to anchors that exist", () => {
    const targets = [...page.matchAll(/\]\(#([^)]+)\)/gu)].map((match) => match[1]);
    expect(targets.length, "the index links to every generative entry").toBeGreaterThan(20);

    const dangling = targets.filter(
      (target) => !headings.has(target) && target !== "advisory-entries",
    );
    expect(dangling, "a table of contents that does not navigate is worse than none").toEqual([]);
  });

  it("discloses network access wherever the catalogue declares it, and nowhere else", () => {
    // The one claim on this page a reader might act on without checking anything else: they are
    // deciding whether generated code will open a socket in their repository. An omission here reads
    // as an assurance.
    const declared = catalog.patterns
      .filter((pattern) => pattern.kind === "generative" && pattern.network !== undefined)
      .map((pattern) => pattern.name);
    expect(declared.length, "two entries reach out, and this test is vacuous if none do").toBe(2);

    const disclosed = sectionsOf(page)
      .filter(([, body]) => body.includes("Reaches the network"))
      .map(([name]) => name);

    expect(disclosed.toSorted()).toEqual(declared.toSorted());
  });

  it("states reserved names where a pattern has them", () => {
    // FR-052's refusal is the cheapest one on the page to avoid, and only if it is on the page.
    const withReserved = sectionsOf(page).filter(([, body]) => body.includes("itself, so an"));
    expect(withReserved.length).toBeGreaterThan(0);

    for (const [name, body] of withReserved) {
      const pattern = catalog.get(name);
      expect(pattern?.kind).toBe("generative");
      expect(body, `${name} claims reserved names, so it must say they are case-insensitive`).toContain(
        "in any casing",
      );
    }
  });

  it("renders a legality rule in the words the refusal would use", async () => {
    // No shipped pattern declares one, so this branch would otherwise first execute on the day someone
    // adds a rule. The point of the rule being data is that a caller can read it before being refused
    // (FR-009), which requires it to be rendered, and rendered unchanged — a page that paraphrases the
    // constraint is a page that can disagree with the engine enforcing it.
    const directory = await mkdtemp(join(tmpdir(), "patterns-docs-"));
    await writeFile(
      join(directory, "type-safety.json"),
      JSON.stringify({ patterns: [withLegality()] }),
      "utf8",
    );

    const rendered = await render(directory);

    expect(rendered).toContain("Refused rather than guessed at");
    expect(rendered, "verbatim, not paraphrased").toContain(
      "`errors: all` cannot be combined with `combinators: false`.",
    );
    expect(rendered, "and the way out, since a refusal without one costs a turn").toContain(
      "set errors to first",
    );
  });
});

/** The page split into `[name, body]` pairs, one per `###` section. */
function sectionsOf(markdown: string): readonly (readonly [string, string])[] {
  const parts = markdown.split(/^### /mu).slice(1);
  return parts.map((part) => {
    const newline = part.indexOf("\n");
    return [part.slice(0, newline), part.slice(newline)] as const;
  });
}

function withLegality(): unknown {
  return {
    name: "fixture",
    title: "Fixture",
    category: "type-safety",
    kind: "generative",
    intent: "Stand in for a pattern that declares a cross-option constraint.",
    supportsSplit: false,
    variants: [],
    // Empty, so `describePattern` does not ask the module registry for reserved names — this pattern
    // exists only in a temporary directory and has no module behind it.
    identifiers: [],
    options: [
      {
        name: "includeTests",
        type: "boolean",
        default: true,
        description: "Emit an executable test suite alongside the implementation.",
        affects: ["files"],
      },
      {
        name: "errors",
        type: "enum",
        values: ["first", "all"],
        default: "all",
        description: "What a failure reports.",
        affects: ["files"],
      },
      {
        name: "combinators",
        type: "boolean",
        default: true,
        description: "Emit a composable parser kit.",
        affects: ["files"],
      },
    ],
    legality: [
      {
        when: { operator: "eq", option: "errors", value: "all" },
        forbids: { option: "combinators", values: [false] },
        rule: "`errors: all` cannot be combined with `combinators: false`.",
        alternatives: ["set errors to first", "set combinators to true"],
      },
    ],
    relatedPatterns: [],
    provenance: "original",
    license: "original",
    tier: 1,
  };
}
