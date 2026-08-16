import { describe, expect, it } from "vitest";

import {
  CorrectableError,
  EngineError,
  IllegalCombinationError,
  InvalidIdentifierError,
  InvalidOptionValueError,
  MissingRequiredOptionError,
  UnknownOptionError,
  UnknownPatternError,
  VerificationError,
  isCorrectable,
} from "../../src/engine/errors.js";

describe("the correctable / internal split", () => {
  const correctable: CorrectableError[] = [
    new UnknownPatternError("resualt", ["result-type"]),
    new UnknownOptionError("erorMode", ["errorMode"]),
    new InvalidOptionValueError("errorMode", "panic", ["result", "throw"]),
    new IllegalCombinationError("Rule text.", ["full"]),
    new InvalidIdentifierError(
      "entityName",
      "class",
      'entityName "class" is reserved',
      "That name is reserved.",
    ),
    new MissingRequiredOptionError(
      "coreModule",
      'when emitScope is "binding-only"',
    ),
  ];

  it.each(correctable.map((e) => [e.name, e] as const))(
    "marks %s correctable",
    (_name, error) => {
      expect(error.correctable).toBe(true);
      expect(isCorrectable(error)).toBe(true);
    },
  );

  it("does not mark a verification failure correctable, since it is our defect", () => {
    const error = new VerificationError("typecheck", "abc123", [
      "some diagnostic",
    ]);
    expect(error.correctable).toBe(false);
    expect(isCorrectable(error)).toBe(false);
  });

  it("gives every error a stable code, so adapters need not match on message text", () => {
    const codes = [...correctable, new VerificationError("tests", "x", [])].map(
      (e) => e.code,
    );
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([
      "unknown_pattern",
      "unknown_option",
      "invalid_option_value",
      "illegal_combination",
      "invalid_identifier",
      "missing_required_option",
      "verification_failed",
    ]);
  });

  it("reports its own class name, so a log line identifies the error without the code", () => {
    expect(new UnknownPatternError("x", []).name).toBe("UnknownPatternError");
    expect(new VerificationError("tests", "x", []).name).toBe(
      "VerificationError",
    );
  });

  it("is catchable as EngineError and as Error", () => {
    const error = new UnknownPatternError("x", []);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toBeInstanceOf(Error);
  });

  it("treats a non-engine error as not correctable", () => {
    expect(isCorrectable(new Error("boom"))).toBe(false);
    expect(isCorrectable(undefined)).toBe(false);
  });
});

describe("messages let a caller fix the call without another round trip", () => {
  it("offers nearest matches for an unknown pattern", () => {
    const error = new UnknownPatternError("resualt", [
      "result-type",
      "result-async",
    ]);
    expect(error.message).toBe(
      'Unknown pattern "resualt". Did you mean: result-type, result-async?',
    );
    expect(error.nearest).toEqual(["result-type", "result-async"]);
  });

  it("points at discovery when nothing is close", () => {
    expect(new UnknownPatternError("zzz", []).message).toBe(
      'Unknown pattern "zzz". List the catalog to see the available patterns.',
    );
  });

  it("keeps adapter vocabulary out of engine messages", () => {
    // The MCP adapter's tool is `list_patterns`; the engine API's method is
    // `listPatterns`. Neither name belongs in an engine-level message, because
    // the engine does not know which adapter is calling it.
    for (const message of [
      new UnknownPatternError("zzz", []).message,
      new UnknownOptionError("x", ["a"]).message,
    ]) {
      expect(message).not.toContain("list_patterns");
      expect(message).not.toContain("describe_pattern");
    }
  });

  it("enumerates the declared options for an unknown one", () => {
    expect(
      new UnknownOptionError("erorMode", ["errorMode", "async"]).message,
    ).toBe(
      'Option "erorMode" is not declared for this pattern. Declared options: errorMode, async.',
    );
  });

  it("says so explicitly when a pattern declares no options", () => {
    expect(new UnknownOptionError("x", []).message).toContain("(none)");
  });

  it("enumerates permitted values for a bad one", () => {
    expect(
      new InvalidOptionValueError("errorMode", "panic", ["result", "throw"])
        .message,
    ).toBe(
      'Option "errorMode" does not accept "panic". Permitted values: result, throw.',
    );
  });

  it.each([
    [42, "42"],
    [true, "true"],
    [null, "null"],
    [undefined, "no value"],
    [{ a: 1 }, "a value of type object"],
  ])(
    "describes the non-string value %s without echoing structure",
    (value, expected) => {
      expect(new InvalidOptionValueError("o", value, ["a"]).message).toContain(
        expected,
      );
    },
  );

  it("truncates a long rejected value, so a refusal cannot amplify input", () => {
    const message = new InvalidOptionValueError("o", "z".repeat(500), ["a"])
      .message;
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(120);
  });

  it("surfaces the catalog rule text verbatim rather than rewording it", () => {
    const rule =
      "Binding-only bundles cannot carry tests for machinery they do not emit.";
    const error = new IllegalCombinationError(rule, ["full", "core-only"]);

    expect(error.message).toBe(`${rule} Valid alternatives: full, core-only.`);
    expect(error.rule).toBe(rule);
    expect(error.alternatives).toEqual(["full", "core-only"]);
  });

  it("names the field, the value and the rule for an invalid identifier", () => {
    const error = new InvalidIdentifierError(
      "entityName",
      "class",
      'entityName "class" is reserved',
      "That name is reserved.",
    );
    expect(error.field).toBe("entityName");
    // The value and the rule are carried separately so an adapter can compose its own sentence
    // without either re-deriving the constraint or filtering this one. Filtering it is what produced
    // a refusal that named the role where the value belonged and never said what was refused.
    expect(error.value).toBe("class");
    expect(error.rule).toBe("That name is reserved.");
    expect(error.message).toContain("is reserved");
  });

  it("says why a required option is required", () => {
    expect(
      new MissingRequiredOptionError(
        "coreModule",
        'when emitScope is "binding-only"',
      ).message,
    ).toBe('Option "coreModule" is required when emitScope is "binding-only".');
  });
});

describe("VerificationError hygiene", () => {
  const diagnostics = [
    "/private/tmp/vfs-9f2/core.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  ];

  it("keeps compiler diagnostics out of the message a caller sees", () => {
    const error = new VerificationError("typecheck", "req-42", diagnostics);

    expect(error.message).not.toContain("TS2322");
    expect(error.message).not.toContain("/private/tmp");
    expect(error.diagnostics).toEqual(diagnostics);
  });

  it("attributes the failure to us, not to the caller", () => {
    const error = new VerificationError("typecheck", "req-42", diagnostics);
    expect(error.message).toContain(
      "defect in the pattern, not in your request",
    );
    expect(error.message).toContain("req-42");
  });

  it("distinguishes a compile failure from a test failure", () => {
    expect(new VerificationError("typecheck", "id", []).message).toContain(
      "failed to compile",
    );
    expect(new VerificationError("tests", "id", []).message).toContain(
      "failed its tests",
    );
  });

  it("takes its correlation id rather than generating one, so the message is deterministic", () => {
    const first = new VerificationError("tests", "fixed-id", []).message;
    const second = new VerificationError("tests", "fixed-id", []).message;
    expect(first).toBe(second);
  });
});
