import { describe, expect, it } from "vitest";

import {
  HASH_LENGTH,
  canonicalize,
  hashCanonical,
  hashResolvedRequest,
  optionsHash,
} from "../../src/engine/provenance/hash.js";

const baseInput = {
  pattern: "result-type",
  options: { emitScope: "full", includeTests: true, retries: 3 },
  identifiers: { entityName: "Person" },
  variant: undefined,
};

describe("canonicalize", () => {
  it("sorts object keys", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys at every depth, not only the top", () => {
    expect(canonicalize({ outer: { b: 1, a: { d: 1, c: 2 } } })).toBe(
      '{"outer":{"a":{"c":2,"d":1},"b":1}}',
    );
  });

  it("produces identical output for objects written in a different order", () => {
    expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalize({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("preserves array order, which is semantic", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize(["b", "a"])).not.toBe(canonicalize(["a", "b"]));
  });

  it("sorts keys inside array elements", () => {
    expect(canonicalize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("omits undefined properties, as JSON does", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("normalises negative zero", () => {
    expect(canonicalize({ a: -0 })).toBe(canonicalize({ a: 0 }));
  });

  it.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
  ])("refuses %s rather than serialising it as null", (value, shown) => {
    // JSON.stringify turns both into null, which would let two different
    // inputs hash identically.
    expect(() => canonicalize({ a: value })).toThrow(new RegExp(shown));
  });

  it("names the path of the offending value", () => {
    expect(() => canonicalize({ outer: { inner: [1, Number.NaN] } })).toThrow(
      /value at outer\.inner\.1/,
    );
  });

  it("refuses a function, which JSON would silently drop", () => {
    expect(() => canonicalize({ a: () => 1 })).toThrow(/type function/);
  });

  it("refuses a symbol", () => {
    expect(() => canonicalize({ a: Symbol("x") })).toThrow(/type symbol/);
  });

  it("handles null and empty containers", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });

  it("escapes strings consistently", () => {
    expect(canonicalize({ a: 'quote"backslash\\newline\n' })).toBe(
      '{"a":"quote\\"backslash\\\\newline\\n"}',
    );
  });
});

describe("optionsHash", () => {
  it("is stable across calls", () => {
    expect(optionsHash(baseInput)).toBe(optionsHash(baseInput));
  });

  it("is stable against a pinned value, so an accidental change is a failing test", () => {
    // A canary, not a security property. If it changes, either the canonical
    // form or the digest changed, and that is an output-affecting change
    // requiring a reviewed diff.
    //
    // Both the canonical string and the digest were computed independently of
    // this implementation — `printf '%s' <canonical> | shasum -a 256` — so the
    // expectation is anchored to something other than the code's own output.
    const canonical =
      '{"identifiers":{"entityName":"Person"},' +
      '"options":{"emitScope":"full","includeTests":true,"retries":3},' +
      '"pattern":"result-type","variant":null}';

    expect(canonicalize({ ...baseInput, variant: null })).toBe(canonical);
    expect(optionsHash(baseInput)).toBe("fcfc817662a7b0cd");
  });

  it("does not depend on the order options were written in", () => {
    expect(
      optionsHash({
        ...baseInput,
        options: { retries: 3, includeTests: true, emitScope: "full" },
      }),
    ).toBe(optionsHash(baseInput));
  });

  it("changes when an option value changes", () => {
    expect(
      optionsHash({
        ...baseInput,
        options: { ...baseInput.options, retries: 4 },
      }),
    ).not.toBe(optionsHash(baseInput));
  });

  it("changes when the pattern changes", () => {
    expect(optionsHash({ ...baseInput, pattern: "builder" })).not.toBe(
      optionsHash(baseInput),
    );
  });

  it("changes when an identifier changes", () => {
    expect(
      optionsHash({ ...baseInput, identifiers: { entityName: "Order" } }),
    ).not.toBe(optionsHash(baseInput));
  });

  it("changes when the variant changes, since variant changes the output", () => {
    expect(optionsHash({ ...baseInput, variant: "tagged" })).not.toBe(
      optionsHash(baseInput),
    );
    expect(optionsHash({ ...baseInput, variant: "tagged" })).not.toBe(
      optionsHash({ ...baseInput, variant: "nested" }),
    );
  });

  it("treats an absent variant as null rather than omitting the key", () => {
    // Adding a variant to a pattern must not change the hash of requests that
    // do not use one.
    expect(optionsHash({ ...baseInput, variant: undefined })).toBe(
      optionsHash(baseInput),
    );
  });

  it("does not conflate an option value with an identifier of the same text", () => {
    const asOption = optionsHash({
      ...baseInput,
      options: { x: "Person" },
      identifiers: {},
    });
    const asIdentifier = optionsHash({
      ...baseInput,
      options: {},
      identifiers: { x: "Person" },
    });
    expect(asOption).not.toBe(asIdentifier);
  });

  it("emits a fixed-length lowercase hex digest", () => {
    const hash = optionsHash(baseInput);
    expect(hash).toHaveLength(HASH_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("hashResolvedRequest", () => {
  it("hashes the request fields and ignores conventions", () => {
    const resolved = {
      pattern: "result-type",
      options: { emitScope: "full" },
      identifiers: {},
      variant: undefined,
      conventions: { moduleStyle: "esm" },
    };
    const withCjs = { ...resolved, conventions: { moduleStyle: "cjs" } };

    // Recorded rather than endorsed: conventions change output bytes, so this
    // is the behaviour data-model.md specifies and blockers.md queries.
    expect(hashResolvedRequest(resolved as never)).toBe(
      hashResolvedRequest(withCjs as never),
    );
  });
});

describe("hashCanonical", () => {
  it("is a pure function of its input string", () => {
    expect(hashCanonical("abc")).toBe(hashCanonical("abc"));
    expect(hashCanonical("abc")).not.toBe(hashCanonical("abd"));
  });
});
