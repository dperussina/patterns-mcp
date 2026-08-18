/**
 * Every name a pattern writes for itself, sent back to it as the caller's name.
 *
 * A template writes some names whatever it is asked for — a core export the binding imports, an
 * illustrative second type an example needs to contrast with the first, the type-level assertion
 * helpers — and derives others by appending a noun to the caller's. Neither kind is inert. A caller
 * whose name lands on a written one gets a module that imports a name and declares it; a caller whose
 * name already ends in the appended noun gets the collapse of FR-046 and, with it, a derived name
 * identical to the name it was derived from. Both produce a bundle that does not compile, and because
 * the compiler runs before anything is returned, both were reported as a defect in the pattern.
 *
 * They were. `branded-type` declares a second brand called `CustomerId` so its example can show that
 * two brands do not interchange, which made `Customer` unusable. `unit-of-work` exports a seam called
 * `Store`, which made `Store` unusable. `AuditRecord` broke that pattern and `repository` both. Three
 * ordinary domain nouns, each answered with "this is a defect in the pattern, not in your request" —
 * true, and no help at all to someone holding a name they cannot use and no idea why.
 *
 * The candidate names are read out of a rendered bundle rather than listed here, because a list is
 * what would not have contained `Record`. Two outcomes are acceptable for each: the bundle compiles,
 * or the name is refused as colliding. The third — a bundle that fails verification — is the defect.
 */
import { describe, expect, it } from "vitest";

import { loadCatalog } from "../../src/engine/catalog/load.js";
import { CorrectableError, VerificationError } from "../../src/engine/errors.js";
import { MODULES } from "../../src/engine/generate/index.js";
import { branchesOf } from "../branches.js";
import { generateBundle } from "../bundle.js";

import type { GenerativePattern } from "../../src/engine/catalog/schema.js";

const catalog = await loadCatalog();

/** Only patterns that read a name can be given a colliding one. */
const patterns = catalog.patterns.filter(
  (candidate): candidate is GenerativePattern =>
    candidate.kind === "generative" && candidate.identifiers.length > 0,
);

/**
 * A name nothing would write literally, so every other name in the output is either fixed by the
 * template or derived from this one — which is what makes the two separable.
 */
const NEUTRAL = "Zebra";

const CONVENTIONS = { testFramework: "node-test" } as const;

/**
 * Suites included, unlike most sweeps. Three of the collisions are with the type-level assertion
 * helpers — `Expect`, `Equal`, `NotAssignable` — which only exist in a `.test-d.ts` file, so excluding
 * the tests would exclude the names.
 */
type Options = Readonly<Record<string, string | number | boolean>>;

async function bundleOf(
  pattern: string,
  entity: string,
  options: Options = {},
): Promise<readonly { path: string; contents: string }[]> {
  const bundle = await generateBundle({
    pattern,
    options: { includeTests: true, ...options },
    conventions: CONVENTIONS,
    identifiers: { entity },
  });
  return bundle.files.map((file) => ({ path: file.path, contents: file.contents }));
}

/*
 * The sweep is `branchesOf` in `test/branches.ts`, shared with the other two suites that read what a
 * pattern emitted. A single render was the first version of this guard, and it missed two names:
 * `specification` writes `RefinedBy` only under `composition=free`, and `unit-of-work` throws
 * `KeyChangedError` only under `tracking=snapshot`. A name a branch writes is written just as literally as
 * one the defaults write, so a candidate list drawn from the defaults alone is a list of the names that
 * happened to be in view.
 */

/** Type and function names a bundle declares, minus anything that came from the caller. */
function fixedNames(files: readonly { contents: string }[]): readonly string[] {
  const names = new Set<string>();

  for (const file of files) {
    for (const match of file.contents.matchAll(
      /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:type|interface|class)\s+([A-Z]\w*)/gm,
    )) {
      names.add(match[1] ?? "");
    }
    // Functions are camel; the entity that would produce one is its Pascal form, which is what a
    // caller sends. `createRepository` is reachable as an entity of `Repository`.
    for (const match of file.contents.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([a-z]\w*)/gm)) {
      const name = match[1] ?? "";
      names.add(`${name.slice(0, 1).toUpperCase()}${name.slice(1)}`);
    }
  }

  return [...names].filter((name) => name !== "" && !name.includes(NEUTRAL));
}

/** Nouns the pattern appends to the caller's name, read off what it did to the neutral one. */
function appendedNouns(files: readonly { contents: string }[]): readonly string[] {
  const nouns = new Set<string>();

  for (const file of files) {
    for (const match of file.contents.matchAll(new RegExp(String.raw`\b${NEUTRAL}([A-Z]\w*)`, "g"))) {
      nouns.add(match[1] ?? "");
    }
  }

  return [...nouns].filter((noun) => noun.length > 1);
}

interface Surface {
  /** Every file of every branch, for asking whether a name is still written anywhere. */
  readonly text: string;
  /** Each name to try, against the options under which the pattern writes it. */
  readonly candidates: ReadonlyMap<string, Options>;
  readonly example: string | undefined;
}

/**
 * Rendered once per pattern per branch, up front. Every case below is a question about these bundles,
 * and the answers do not depend on the caller's name, so rendering them again per case would only make
 * a slow sweep slower.
 */
async function surfaceOf(pattern: GenerativePattern): Promise<Surface> {
  const candidates = new Map<string, Options>();
  let text = "";
  let example: string | undefined;

  for (const branch of branchesOf(pattern)) {
    let files: readonly { path: string; contents: string }[];
    try {
      files = await bundleOf(pattern.name, NEUTRAL, branch.options);
    } catch {
      // A branch this pattern will not generate for a neutral name is the catalogue's business; it
      // writes no names here either way.
      continue;
    }

    text += files.map((file) => file.contents).join("\n");
    example ??= files.find((file) => file.path.includes("example"))?.contents;

    const names = [
      ...fixedNames(files),
      // Both shapes of the collapse: the bare noun, and an ordinary compound ending in it.
      ...appendedNouns(files).flatMap((noun) => [noun, `Audit${noun}`]),
    ];
    for (const name of names) {
      // First branch that writes it wins, so a name shared with the defaults is tried at the defaults.
      if (!candidates.has(name)) candidates.set(name, branch.options);
    }
  }

  return { text, candidates, example };
}

const rendered = new Map<string, Surface>(
  await Promise.all(patterns.map(async (pattern) => [pattern.name, await surfaceOf(pattern)] as const)),
);

/**
 * One case per pattern rather than per name. A name is cheap to try and a bundle is not, so this
 * sweep is minutes long either way; grouping keeps a failure reporting every name that broke instead
 * of the first one, which is what tells you whether a fix is one line or a rethink.
 */
describe("a name the pattern writes itself", () => {
  it.each(patterns.map((pattern) => pattern.name))(
    "is usable or refused, never a defect: %s",
    async (name) => {
      const candidates = rendered.get(name)?.candidates ?? new Map<string, Options>();

      expect(candidates.size, `${name} produced no names to try`).toBeGreaterThan(0);

      const defects: string[] = [];
      for (const [entity, options] of candidates) {
        try {
          await bundleOf(name, entity, options);
        } catch (error) {
          // A refusal is a complete answer: the caller is told the name is taken and can send another.
          // Anything else is the bundle we would have shipped failing its own compiler.
          if (error instanceof VerificationError || !(error instanceof CorrectableError)) {
            defects.push(entity);
          }
        }
      }

      expect(defects, `${name} cannot generate for names it writes itself`).toEqual([]);
    },
    600_000,
  );
});

/**
 * The other direction, and the one a caller notices. Each of these was a bundle that did not compile,
 * and each is a name someone would reach for without a second thought — which is why they are pinned
 * by name rather than left to the sweep above, where a future rename could quietly drop them.
 */
describe("an ordinary domain noun that a pattern's own naming had taken", () => {
  it.each([
    ["branded-type", "Customer", "a second brand named CustomerId"],
    ["unit-of-work", "Store", "the core's Store seam"],
    ["unit-of-work", "AuditRecord", "the record type the collapse derives"],
    ["unit-of-work", "AuditTracking", "the tracking type the collapse derives"],
    ["repository", "AuditRecord", "the record type the collapse derives"],
  ])("generates: %s for %s, which used to collide with %s", async (pattern, entity) => {
    const files = await bundleOf(pattern, entity);

    expect(files.length).toBeGreaterThan(0);
    expect(files.map((file) => file.contents).join("\n")).toContain(entity);
  }, 180_000);

  /**
   * A stand-in that quietly differs from the name that was asked for is its own small betrayal, so the
   * file says why. Asserted because the explanation is the whole reason stepping aside is acceptable.
   */
  it("says in the file why the example's stand-in is not called what was asked for", async () => {
    const files = await bundleOf("unit-of-work", "Store");
    const example = files.find((file) => file.path.includes("example"));

    expect(example?.contents).toContain("SampleStore");
    expect(example?.contents).toMatch(/Called `SampleStore` here only because/);
  }, 180_000);

  /**
   * The branch half of the same class, kept by name because these two were found only after the sweep
   * was widened to render every option value, and a narrowing of it would otherwise go unnoticed.
   */
  it.each([
    ["specification", "RefinedBy", { composition: "free" }],
    ["unit-of-work", "KeyChangedError", { tracking: "snapshot" }],
  ] as const)("is refused where only a branch writes it: %s for %s", async (pattern, entity, options) => {
    await expect(bundleOf(pattern, entity, options)).rejects.toThrow(CorrectableError);
  }, 120_000);
});

/**
 * The same collision, spelled the way a caller might actually type it.
 *
 * A pattern writes `Repository`, and the refusal compared the string it was sent — so `repository` was
 * accepted, derived to `Repository` at the declaration site, and failed to compile. Six of the thirteen
 * declared names had a lowercase spelling that got through, which is every one of them a caller would
 * plausibly write that way. The comparison is now on the derived form, which is also why the all-caps
 * spelling is not refused: `REPOSITORY` stays an acronym through the derivation and stays a different
 * name.
 */
describe("a refused name sent in another casing", () => {
  it.each(
    MODULES.flatMap((module) =>
      (module.emits ?? []).map(
        (name) => [module.name, `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`] as const,
      ),
    ).filter(([, spelling]) => spelling !== ""),
  )("is refused too: %s for %s", async (pattern, entity) => {
    // Only interesting where the spelling differs from the declared one, which is every current case.
    await expect(bundleOf(pattern, entity)).rejects.toThrow(CorrectableError);
  }, 120_000);
});

/**
 * A refusal is only defensible while it is necessary. A name listed as emitted but no longer written
 * is a request the service could serve and declines to, which no test would otherwise notice — the
 * sweep above passes either way, since a refused name and a working one are both acceptable to it.
 */
describe("a name a pattern declares as its own", () => {
  it.each(
    MODULES.flatMap((module) => (module.emits ?? []).map((name) => [module.name, name] as const)),
  )("is a name %s actually writes: %s", (pattern, name) => {
    // Across every branch, since two of the declared names exist in one branch only.
    const text = rendered.get(pattern)?.text ?? "";

    // Compared case-insensitively at the word boundary: a function is written camel and reached as
    // Pascal, and `Repository` is claimed on account of `createRepository`.
    expect(text, `${pattern} refuses ${name} but no longer emits it`).toMatch(
      new RegExp(String.raw`\b\w*${name}\b`, "i"),
    );
  });
});
