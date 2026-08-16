/**
 * An advisory pattern, over the wire, as a success (FR-022, FR-023).
 *
 * The engine's half of this is asserted in `test/unit/generate.test.ts`; what is only observable here is
 * whether the *protocol* carries it as a success. Three things could go wrong at this boundary and none
 * of them would fail a unit test:
 *
 * - `isError` set, because the adapter's error path is the one that handles "no files". An agent reading
 *   `isError` would retry a request that was already answered, or report a failure to a user.
 * - The result rejected by output-schema validation. The schema is a discriminated union, and the SDK
 *   validates results against it; a union that serialised wrongly would surface as a client-side throw
 *   rather than as a schema complaint, which is why this asserts on a completed call.
 * - The rendered text reading as an apology. A caller who receives no code needs the first line to
 *   account for that, or the reply looks like an answer to a different question.
 *
 * The advisory entries are also asserted to be visible *before* the call, which is FR-023's whole point:
 * a caller who filters the catalogue can avoid asking.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect } from "./client.js";

import type { Session } from "./client.js";

let session: Session;

beforeAll(async () => {
  session = await connect();
});

afterAll(async () => {
  await session.close();
});

/** Every advisory entry, so a new one is covered without this file being edited. */
async function advisoryNames(): Promise<readonly string[]> {
  const result = await session.client.callTool({
    name: "list_patterns",
    arguments: { kind: "advisory" },
  });
  const structured = result.structuredContent as {
    patterns: readonly { name: string }[];
  };
  return structured.patterns.map((pattern) => pattern.name);
}

describe("the catalogue", () => {
  it("marks advisory entries so a caller can avoid the call (FR-023)", async () => {
    const names = await advisoryNames();

    expect(names.length, "no advisory entries would make this suite vacuous").toBeGreaterThan(0);
    expect(names).toContain("singleton");
  });

  it("does not mix them into a generative listing", async () => {
    const result = await session.client.callTool({
      name: "list_patterns",
      arguments: { kind: "generative" },
    });
    const structured = result.structuredContent as {
      patterns: readonly { name: string }[];
    };

    expect(structured.patterns.map((pattern) => pattern.name)).not.toContain("singleton");
  });
});

describe("asking to generate an advisory pattern", () => {
  it("is answered as a success, with the alternative and its rationale", async () => {
    const names = await advisoryNames();

    for (const name of names) {
      const result = await session.client.callTool({
        name: "generate_pattern",
        arguments: { pattern: name },
      });

      // `undefined` rather than `false` is what the SDK sends for a result that is not an error, so
      // this asserts falsiness deliberately rather than identity with `false`.
      expect(result.isError, `${name} came back marked as an error`).toBeFalsy();

      const structured = result.structuredContent as {
        kind: string;
        pattern: string;
        alternative: string;
        rationale: string;
      };

      expect(structured.kind).toBe("advisory");
      expect(structured.pattern).toBe(name);
      expect(structured.alternative.length).toBeGreaterThan(0);
      expect(structured.rationale.length).toBeGreaterThan(0);
    }
  });

  it("says plainly that nothing was generated, and why that is the answer", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "singleton" },
    });

    const text = (result.content as readonly { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("\n");

    expect(text).toContain("superseded");
    expect(text).toContain("nothing was generated");
    // The alternative has to be in the prose and not only in the structured half: a host that shows a
    // user the text and drops `structuredContent` would otherwise show them a refusal with no remedy.
    expect(text).toContain("a module that exports the value");
  });

  it("carries no verification record, since there is nothing to have verified", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "singleton" },
    });

    const structured = result.structuredContent as Record<string, unknown>;

    // Stated as an assertion because the alternative — an empty record, or a record of zeroes — would
    // be a claim that something was checked. Absence is the honest encoding.
    expect(structured["verification"]).toBeUndefined();
    expect(structured["files"]).toBeUndefined();
  });
});
