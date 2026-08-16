/**
 * Which patterns can reach the network, checked against which ones say they can (FR-034).
 *
 * The requirement used to forbid network access in generated code outright. Read literally against the
 * catalogue, that outlawed `gateway` and `chat-model-port` — the two patterns whose entire subject is
 * putting a typed, testable edge around an HTTP call — so the two most in need of a reviewed shape were
 * the two the requirement said could not exist. It was amended to forbid *undeclared* access instead,
 * which only means something if the declaration is checked. Prose in a spec is not a control.
 *
 * So both directions are asserted, and the second matters as much as the first: a pattern that emits
 * `fetch` without declaring it is the leak, and a pattern that declares network access it does not take is
 * a warning a caller learns to ignore. The catalogue is generated over every branch, because a network
 * call reachable only under one option value is reachable.
 */
import { describe, expect, it } from "vitest";

import { loadCatalog } from "../../src/engine/catalog/load.js";
import { generateBundle } from "../bundle.js";

import type { GenerativePattern } from "../../src/engine/catalog/schema.js";

const catalog = await loadCatalog();

const patterns = catalog.patterns.filter(
  (candidate): candidate is GenerativePattern => candidate.kind === "generative",
);

const CONVENTIONS = { testFramework: "node-test" } as const;

/**
 * Every way the runtime lets code reach a network, as it would appear in emitted source.
 *
 * The `fetch` rule looks for the *global* used as a value, which is a different thing from the word
 * appearing on a line, and the distinction is the whole difficulty. Patterns that never dial still talk
 * about `fetch` constantly: they take one as a parameter (`readonly fetch?: FetchLike`), pass a stub in
 * (`fetch: transport.fetch`), and explain in prose why the seam is there. None of those reach anything.
 * Meanwhile the one line that does reach is `config.fetch ?? fetch` — a bare reference, invoked later
 * through an alias, so a call-shaped search finds nothing. It found nothing here first, and the suite
 * reported a pattern that plainly does call out as declaring network access it did not take.
 *
 * Hence: not preceded by a dot, so a member access is a use of somebody else's; not followed by `:` or
 * `?`, so a property name or a declaration is not a use at all.
 */
const REACHES_NETWORK = [
  /(?<![.\w$])fetch\s*(?![:?\w])/u,
  /\bnode:(?:net|tls|http|https|http2|dgram|dns)\b/u,
  /\bXMLHttpRequest\b/u,
  /\bnew\s+WebSocket\b/u,
  /\bnavigator\s*\.\s*sendBeacon\b/u,
];

type Options = Readonly<Record<string, string | number | boolean>>;

/** The defaults plus one render per non-default option value, matching the emitted-names sweep. */
function branchesOf(pattern: GenerativePattern): readonly { readonly label: string; readonly options: Options }[] {
  const branches: { label: string; options: Options }[] = [{ label: "defaults", options: {} }];

  for (const option of pattern.options) {
    if (option.name === "includeTests") continue;
    const values: readonly (string | number | boolean)[] =
      option.type === "enum" ? option.values : option.type === "boolean" ? [true, false] : [];
    for (const value of values) {
      if (value === option.default) continue;
      branches.push({
        label: `${option.name}=${String(value)}`,
        options: {
          [option.name]: value,
          // A scope narrower than `full` emits bindings that import machinery from somewhere, and the
          // engine requires being told where (FR-018). Without this the three splittable patterns refuse
          // the branch, and a branch that never renders is a branch whose network calls go unread.
          ...(option.name === "emitScope" && value !== "full" ? { coreModule: "./core.js" } : {}),
        },
      });
    }
  }

  return branches;
}

/** Where a network primitive appears across every branch of one pattern, as `path:line`. */
async function reachesFrom(pattern: GenerativePattern): Promise<readonly string[]> {
  const sightings = new Set<string>();
  let rendered = 0;

  for (const branch of branchesOf(pattern)) {
    const identifiers = Object.fromEntries(pattern.identifiers.map((role) => [role.name, "Zebra"]));

    let files: readonly { readonly path: string; readonly contents: string }[];
    try {
      const bundle = await generateBundle({
        pattern: pattern.name,
        options: { includeTests: true, ...branch.options },
        conventions: CONVENTIONS,
        identifiers,
      });
      files = bundle.files;
    } catch (error) {
      // A combination the catalogue declares illegal is not this suite's business. Counted rather than
      // ignored: if every branch refused, the assertion below would be vacuously true.
      if (error instanceof Error && error.name.endsWith("Error")) continue;
      throw error;
    }

    rendered += 1;

    for (const file of files) {
      for (const [index, line] of file.contents.split("\n").entries()) {
        // Comments discuss transports in patterns that never call one, and a prose mention is not a call.
        const code = line.replace(/\/\/.*$/u, "").replace(/^\s*\*.*$/u, "");
        if (REACHES_NETWORK.some((primitive) => primitive.test(code))) {
          sightings.add(`${file.path}:${String(index + 1)}`);
        }
      }
    }
  }

  if (rendered === 0) throw new Error(`${pattern.name} rendered under no branch, so nothing was read`);

  return [...sightings].toSorted();
}

describe("a pattern that can reach the network declares it", () => {
  it.each(patterns.map((pattern) => pattern.name))(
    "%s",
    async (name) => {
      const pattern = patterns.find((candidate) => candidate.name === name);
      if (pattern === undefined) throw new Error(`${name} left the catalogue mid-run`);

      const sightings = await reachesFrom(pattern);
      const declared = pattern.network !== undefined;

      if (sightings.length > 0 && !declared) {
        expect.fail(
          `${pattern.name} emits a network primitive at ${sightings.join(", ")} and declares no ` +
            `"network" in its catalogue entry. Either route the call through a boundary the caller ` +
            `supplies and declare it, or remove the call (FR-034).`,
        );
      }

      if (sightings.length === 0 && declared) {
        expect.fail(
          `${pattern.name} declares "network" in its catalogue entry but emits no network primitive ` +
            `under any option. A disclosure a caller cannot act on teaches them to skip the next one.`,
        );
      }
    },
    240_000,
  );
});

describe("what a declaration has to say", () => {
  const declaring = patterns.filter((pattern) => pattern.network !== undefined);

  it("is made by more than nothing, or this suite is asserting against an empty set", () => {
    expect(declaring.length).toBeGreaterThan(0);
  });

  it.each(declaring.map((pattern) => pattern.name))(
    "%s names the boundary a caller replaces",
    (name) => {
      const pattern = declaring.find((candidate) => candidate.name === name);
      const declaration = pattern?.network;
      if (pattern === undefined || declaration === undefined) throw new Error("filtered above");

      // The point of the field. "It is injectable" is only actionable next to what to inject, so the
      // boundary has to be a name that appears in the pattern's own surface — an option or an identifier
      // role — rather than a description of one.
      const surface = [
        ...pattern.options.map((option) => option.name),
        ...pattern.identifiers.map((role) => role.name),
        // Not every boundary is an option: `chat-model-port` takes its transport as a config field on the
        // emitted factory, which is a name in the generated code rather than in the request.
        "fetch",
        "transport",
      ];

      expect(surface).toContain(declaration.boundary);
    },
  );
});
