/**
 * The catalogue's identifier declarations, checked against what the patterns actually do.
 *
 * A declaration is a promise to a caller, and `describe_pattern` is the only place they can read it,
 * so a wrong one is worse than none: it sends an agent to supply a name that changes nothing, or to
 * omit one that mattered. Both halves are swept over every pattern rather than sampled, because the
 * declaration is per pattern and a sample says nothing about the one added next month.
 *
 * The defect this exists for: `entity` used to be accepted by all twenty-six, read by twenty, and
 * silently dropped by six — while still entering the provenance hash, so the six returned
 * byte-different headers over a name none of their files used.
 */
import { describe, expect, it } from "vitest";

import { loadCatalog } from "../../src/engine/catalog/load.js";
import { InvalidIdentifierError, UnknownIdentifierError } from "../../src/engine/errors.js";
import { generateBundle } from "../bundle.js";
import { MAX_IDENTIFIER_LENGTH } from "../../src/engine/options/identifiers.js";

import type { GenerativePattern } from "../../src/engine/catalog/schema.js";

const catalog = await loadCatalog();
const patterns = catalog.patterns.filter(
  (candidate): candidate is GenerativePattern => candidate.kind === "generative",
);

/**
 * Tests excluded throughout. The question is whether a name reaches the code, and a suite is the
 * most expensive half of a bundle to produce — this sweep generates twice per pattern.
 */
const CONVENTIONS = { testFramework: "node-test" } as const;

/**
 * The longest name the validator accepts, so that sweeping it bounds every name a caller can send.
 *
 * Asserted against the limit rather than merely being long, because the two have to move together:
 * raise the limit and this stops testing the boundary, silently, which is how the sites it found got
 * in. It ends in a regularly-pluralising noun on purpose — a name whose plural cannot be derived is
 * refused, and this case is about length rather than derivability.
 */
const LONGEST = "AggregatedQuarterlyCustomerBillingStatementSupplementaryLineItem";

async function filesOf(
  pattern: string,
  identifiers?: Readonly<Record<string, string>>,
  includeTests = false,
): Promise<string> {
  const bundle = await generateBundle({
    pattern,
    options: { includeTests },
    conventions: CONVENTIONS,
    ...(identifiers === undefined ? {} : { identifiers }),
  });
  return bundle.files.map((file) => `${file.path}\n${file.contents}`).join("\n");
}

describe("a declared identifier", () => {
  it.each(patterns.flatMap((pattern) => pattern.identifiers.map((role) => [pattern.name, role.name] as const)))(
    "reaches the generated code: %s.%s",
    async (name, role) => {
      const [generic, named] = await Promise.all([
        filesOf(name),
        filesOf(name, { [role]: "Voucher" }),
      ]);

      expect(named, `${name} ignores the ${role} it declares`).not.toEqual(generic);
      // Not merely different — the name itself has to appear, or the difference is the provenance
      // hash moving and nothing else, which is the exact defect this sweep was written for.
      expect(named, `${name} does not use the ${role} it was given`).toContain("Voucher");
    },
    120_000,
  );
});

describe("an identifier a pattern does not declare", () => {
  it.each(patterns.map((pattern) => pattern.name))(
    "is refused rather than dropped: %s",
    async (name) => {
      // `nonsense` for every pattern, and `entity` for the ones that read none — the second is the
      // habit that made the old behaviour dangerous, since it looks correct and used to be accepted.
      await expect(filesOf(name, { nonsense: "Voucher" })).rejects.toThrow(UnknownIdentifierError);
    },
  );

  it.each(patterns.filter((pattern) => pattern.identifiers.length === 0).map((p) => p.name))(
    "includes the habitual `entity`: %s",
    async (name) => {
      await expect(filesOf(name, { entity: "Voucher" })).rejects.toThrow(/takes none/);
    },
  );
});

/**
 * The other half of the same defect, found by the same sweep. An identifier is refused when its
 * plural cannot be derived, because a generated file names both forms and an approximation cannot be
 * un-shipped — but the pipeline caught that refusal and dropped it, falling back to generic names.
 * A caller asking for a `Staff` repository received `EntityRepository` and was told nothing.
 */
describe("an identifier whose plural cannot be derived", () => {
  it("is refused, rather than quietly becoming a generic name", async () => {
    // `Staff`: staffs, staves, or unchanged, and absent from the exception table. Genuinely doubtful,
    // unlike the `-ion` nouns this same investigation found were being refused for no reason.
    await expect(filesOf("repository", { entity: "Staff" })).rejects.toThrow(InvalidIdentifierError);
  });

  it("says which rule could not be applied, and that a different name is the way out", async () => {
    await expect(filesOf("repository", { entity: "Staff" })).rejects.toThrow(
      /cannot derive a plural.*Supply a different name/s,
    );
  });

  it.each(["Subscription", "Transaction", "Session", "Notification", "Region"])(
    "is not what happens to an ordinary -ion noun: %s",
    async (entity) => {
      // The refusal above is only tolerable because it is rare. It was not: these were all refused
      // until the `-on` rule was narrowed, so making the drop visible would have turned a silent
      // degradation into a hard refusal for most of a realistic domain vocabulary.
      await expect(filesOf("repository", { entity })).resolves.toContain(entity);
    },
    120_000,
  );
});

describe("a pattern that declares an identifier", () => {
  it.each(patterns.filter((pattern) => pattern.identifiers.length > 0).map((p) => p.name))(
    "still generates without one, since each is optional: %s",
    async (name) => {
      await expect(filesOf(name)).resolves.toContain("export");
    },
    120_000,
  );

  /**
   * The golden suite pins one noun, `Order`, and a name's length is not inert: it decides where the
   * formatter wraps, and a wrapped line can carry a `@ts-expect-error` away from the error it was
   * written to assert. The directive then suppresses nothing and the escaped mistake is reported, so
   * the pattern fails verification — for a caller's choice of noun, on a line the caller never sees.
   *
   * Found by this file's own sweep, which reached for `Voucher` and broke `discriminated-union` at
   * two sites. Two more patterns broke at the limit below, which is why the limit is what is swept:
   * a middling name proves nothing about the ones on either side of it, whereas the longest a caller
   * can send bounds every name they can send.
   */
  it("sweeps the boundary rather than merely a long name", () => {
    expect(LONGEST).toHaveLength(MAX_IDENTIFIER_LENGTH);
  });

  it.each(patterns.filter((pattern) => pattern.identifiers.length > 0).map((p) => p.name))(
    "generates for the longest name a caller may send, not only for a short one: %s",
    async (name) => {
      await expect(filesOf(name, { entity: LONGEST })).resolves.toContain(LONGEST);
    },
    120_000,
  );

  /**
   * The third defect from the same cause as the two above, and the cheapest to state: `Order` is one
   * word, so `subject.toLowerCase()` and the camel form coincide and nothing distinguishes them. For
   * any name with a second word they diverge — `WebhookEvent` lowercased whole is `webhookevent` —
   * and that was reaching callers as `parse-dont-validate`'s exported `webhookeventId`, with
   * `typestate` putting it in an error message a person reads. Both compiled and both passed their
   * own suites, because a run-together name is only wrong to a reader.
   *
   * The assertion is the absence of the concatenation rather than the presence of the camel form: a
   * pattern is free not to need a value name at all, but none of them is free to run the words
   * together. Kebab paths and screaming-snake constants are unaffected, since neither can produce it.
   */
  /**
   * Two shapes a name can only take when a template cases it by hand, and neither is reachable with
   * `Order`, where every derivation coincides.
   *
   * Running the words together comes from lowercasing the whole subject: `WebhookEvent` becomes
   * `webhookevent`, which reached callers as `parse-dont-validate`'s exported `webhookeventId`.
   * Lowering a single leading character instead is right for `OrderId` and wrong for every acronym:
   * `APIKeyId` became `aPIKeyId`, likewise exported. Both compiled and both passed their own suites,
   * because a mis-cased name is only wrong to a reader — which is why these are asserted rather than
   * left to be noticed.
   */
  it.each(
    patterns
      .filter((pattern) => pattern.identifiers.length > 0)
      .flatMap((pattern) => [
        [pattern.name, "WebhookEvent", /webhookevent/, "runs the words together"] as const,
        [pattern.name, "APIKey", /\b[a-z][A-Z]{2,}/, "lowercases only the first letter"] as const,
      ]),
  )("cases %s correctly for %s", async (name, entity, forbidden, fault) => {
    // With the tests, unlike its neighbours above. A test title is prose about the subject, and the
    // run-together form reached callers there as well as in the identifiers: `parse-dont-validate`
    // titled a case "accepts a well-formed webhookevent".
    const files = await filesOf(name, { entity }, true);

    expect(files, `${name} ${fault} instead of using the camel form`).not.toMatch(forbidden);
  }, 180_000);
});