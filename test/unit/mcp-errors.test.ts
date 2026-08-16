/**
 * What a caller is told, and what is kept back (FR-035, FR-038).
 *
 * Two audiences, two channels. The caller gets a message they can act on, with no compiler output, no
 * paths, and no verbatim echo of anything they supplied. The operator gets the detail on stderr, keyed
 * by the identifier the caller was given, because an identifier that leads nowhere invites a bug report
 * that cannot be looked up.
 *
 * The contract suites already assert the caller-facing half over the protocol. These cover the logging
 * half, which is invisible from the wire and would otherwise be untested.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  InvalidOptionValueError,
  UnknownPatternError,
  VerificationError,
} from "../../src/engine/errors.js";
import { ConventionsSchema } from "../../src/engine/options/conventions.js";
import { toErrorResult, unrecognisedArguments } from "../../src/mcp/errors.js";
import { CORRECTABLE_META_KEY, ERROR_CODE_META_KEY } from "../../src/mcp/meta.js";
import { generateInput } from "../../src/mcp/tools/generate.js";

function capture(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

function textOf(result: { content: unknown }): string {
  return (result.content as readonly { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("a verification failure", () => {
  const diagnostics = ["order-result.ts: TS2322 Type 'string' is not assignable to type 'number'."];

  it("tells the caller an identifier and nothing else", () => {
    const sink = capture();
    const result = toErrorResult(
      new VerificationError("typecheck", "abc123", diagnostics),
      sink.log,
    );

    const text = textOf(result);
    expect(text).toContain("abc123");
    expect(text).not.toContain("TS2322");
    expect(text).not.toContain("order-result.ts");
  });

  it("records the diagnostics against that identifier", () => {
    const sink = capture();
    toErrorResult(new VerificationError("typecheck", "abc123", diagnostics), sink.log);

    const logged = sink.lines.join("\n");
    expect(logged).toContain("abc123");
    expect(logged).toContain("TS2322");
    expect(logged).toContain("typecheck");
  });

  it("is reported as our defect rather than a correctable input", () => {
    const sink = capture();
    const result = toErrorResult(new VerificationError("tests", "abc123", diagnostics), sink.log);

    expect(result._meta?.[CORRECTABLE_META_KEY]).toBe(false);
    expect(result._meta?.[ERROR_CODE_META_KEY]).toBe("verification_failed");
  });
});

describe("a correctable refusal", () => {
  it("is not logged, because it is the caller's business and not a fault", () => {
    const sink = capture();
    toErrorResult(new UnknownPatternError("reslt", ["result"]), sink.log);
    toErrorResult(new InvalidOptionValueError("includeTests", "yes", ["true", "false"]), sink.log);

    expect(sink.lines).toEqual([]);
  });
});

/**
 * The refusal for a misplaced value tells the caller which names are conventions, and it has to know them
 * to do that — which means holding a copy of the schema's keys, since a schema cannot ask itself what its
 * keys are while being defined. This is the copy being wrong: a convention added to the tool and not here
 * would be refused as "not an argument of this tool", sending the caller to look for it somewhere it is not.
 */
describe("the list of conventions the refusal knows about", () => {
  it("is the list the tool accepts", () => {
    const accepted = toolConventions();

    for (const name of accepted) {
      expect(
        unrecognisedArguments([name], accepted),
        `${name} is a convention the refusal does not recognise as one`,
      ).toContain('inside "conventions"');
    }
  });

  /**
   * Both directions, because one direction is what let a convention go missing.
   *
   * The check above asks whether the refusal knows every convention the *tool* accepts, and passed
   * throughout the time `runtime` was absent from the tool — the engine took it, the CLI passed it
   * through, and an MCP caller was told it "is not a convention". A subset check cannot see that: the
   * copy it compares against was the incomplete one.
   *
   * So the comparison is against the engine's schema, which is the only definition that decides what a
   * convention *is*. Two surfaces reaching one engine is the whole design (Principle X); a field one
   * surface can set and the other cannot is that design failing quietly.
   */
  it("is the list the engine accepts, so neither surface offers less than the other", () => {
    const engine = Object.keys(ConventionsSchema.unwrap().shape).toSorted();

    expect(toolConventions().toSorted()).toEqual(engine);
  });

  it("accepts the same values per convention as the engine, field by field", () => {
    const engine = ConventionsSchema.unwrap().shape as Readonly<Record<string, z.ZodType>>;
    const tool = toolConventionShape();

    for (const [name, schema] of Object.entries(engine)) {
      const permitted = valuesOf(schema);
      if (permitted === undefined) continue;

      expect(
        valuesOf(tool[name] as z.ZodType)?.toSorted(),
        `the tool and the engine disagree about what ${name} accepts`,
      ).toEqual(permitted.toSorted());
    }
  });
});

function toolConventionShape(): Readonly<Record<string, unknown>> {
  return (generateInput.shape.conventions.unwrap() as z.ZodObject<z.ZodRawShape>).shape;
}

function toolConventions(): readonly string[] {
  return Object.keys(toolConventionShape());
}

/**
 * The values an enumeration accepts, reaching through whichever wrapper each surface put around it —
 * `.default()` on the engine's side, `.optional()` and `.describe()` on the tool's. `undefined` for a
 * field that is not an enumeration, since `prettierConfig` has no value list to compare.
 */
function valuesOf(schema: z.ZodType): readonly string[] | undefined {
  let inner: unknown = schema;

  for (let depth = 0; depth < 5; depth += 1) {
    if (inner instanceof z.ZodEnum) return Object.values(inner.enum) as readonly string[];
    if (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodDefault ||
      inner instanceof z.ZodNullable
    ) {
      inner = inner.unwrap();
      continue;
    }
    return undefined;
  }

  return undefined;
}

describe("an error from nowhere", () => {
  it("is logged with its stack and reported without one", () => {
    const sink = capture();
    const result = toErrorResult(new TypeError("cannot read properties of undefined"), sink.log);

    expect(textOf(result)).not.toContain("cannot read properties");
    expect(sink.lines.join("\n")).toContain("cannot read properties");
    expect(result._meta?.[ERROR_CODE_META_KEY]).toBe("internal_error");
  });
});
