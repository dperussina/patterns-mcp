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

import {
  InvalidOptionValueError,
  UnknownPatternError,
  VerificationError,
} from "../../src/engine/errors.js";
import { toErrorResult } from "../../src/mcp/errors.js";

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

    expect(result._meta?.["dev.patterns/correctable"]).toBe(false);
    expect(result._meta?.["dev.patterns/errorCode"]).toBe("verification_failed");
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

describe("an error from nowhere", () => {
  it("is logged with its stack and reported without one", () => {
    const sink = capture();
    const result = toErrorResult(new TypeError("cannot read properties of undefined"), sink.log);

    expect(textOf(result)).not.toContain("cannot read properties");
    expect(sink.lines.join("\n")).toContain("cannot read properties");
    expect(result._meta?.["dev.patterns/errorCode"]).toBe("internal_error");
  });
});
