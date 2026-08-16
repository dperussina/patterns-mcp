/**
 * The `generate_pattern` tool, over the protocol.
 *
 * What matters here is the evidence that reaches the caller. The engine refuses to return an
 * unverified bundle, but a caller cannot see that refusal — it sees a response. So these assert the
 * response carries the proof: zero diagnostics, and a test outcome that distinguishes "ran and
 * passed" from "there were none to run" (Principle III, contracts/mcp-tools.md).
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

interface Verification {
  readonly diagnosticCount: number;
  readonly testOutcome: string;
  readonly compilerVersion: string;
  readonly contentHash: string;
  readonly compilerOptions: Readonly<Record<string, unknown>>;
}

interface Bundle {
  readonly kind: string;
  readonly pattern: string;
  readonly files: readonly {
    readonly path: string;
    readonly role: string;
    readonly contents: string;
  }[];
  readonly verification: Verification;
  readonly resolvedOptions: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
  readonly nextSteps: readonly string[];
}

function bundleOf(structuredContent: unknown): Bundle {
  return structuredContent as Bundle;
}

/** The human-readable block, which is the half `verbosity` governs. */
function textOf(result: { readonly content?: unknown }): string {
  return (result.content as readonly { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("a successful generate_pattern call", () => {
  it("returns a verified bundle", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "result", identifiers: { entity: "Order" } },
    });

    expect(result.isError).toBeFalsy();
    const bundle = bundleOf(result.structuredContent);
    expect(bundle.kind).toBe("bundle");
    expect(bundle.pattern).toBe("result");
    expect(bundle.verification.diagnosticCount).toBe(0);
    expect(bundle.verification.testOutcome).toBe("passed");
  }, 120_000);

  it("names the toolchain that produced it, so the evidence is attributable", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "result", identifiers: { entity: "Order" } },
    });

    const bundle = bundleOf(result.structuredContent);
    expect(bundle.verification.compilerVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(bundle.verification.contentHash).toMatch(/^[0-9a-f]{16}$/);
  }, 120_000);

  /**
   * The catalog validator refuses `verbosity` as a pattern option because it would enter the resolved
   * set and therefore the hash. That refusal only protects the property if the tool layer also keeps
   * verbosity out of the request it hands the engine, which is what this checks: the hash identifies
   * the bundle, and asking for a terser description of the same bundle cannot change what it is.
   */
  it("hashes the bundle, not the description of it", async () => {
    const args = { pattern: "result", identifiers: { entity: "Order" } };

    const verbose = await session.client.callTool({
      name: "generate_pattern",
      arguments: { ...args, verbosity: "full" },
    });
    const terse = await session.client.callTool({
      name: "generate_pattern",
      arguments: { ...args, verbosity: "summary" },
    });

    const a = bundleOf(verbose.structuredContent);
    const b = bundleOf(terse.structuredContent);
    expect(b.verification.contentHash).toBe(a.verification.contentHash);
    expect(Object.keys(b.resolvedOptions)).toEqual(Object.keys(a.resolvedOptions));
    expect(b.resolvedOptions.verbosity).toBeUndefined();
  }, 120_000);

  it("carries a readable block alongside the structured result", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "result", identifiers: { entity: "Order" } },
    });

    // An agent that ignores structuredContent still has to be able to read the code, and the file
    // paths have to be visible in it or the caller cannot tell which block goes where.
    const text = textOf(result);
    expect(text).toContain("order-result.ts");
    expect(text).toContain("export type OrderResult");
  }, 120_000);

  /**
   * The reported options are the ones it was checked under, not ours (FR-025, FR-026).
   *
   * This is the difference between evidence and decoration. A caller whose project is `strictest` needs
   * to know the bundle survived *that*, and a record naming our own defaults would read identically
   * while proving nothing about their build. Asserted through the protocol rather than against the
   * mapping function, which is separately unit-tested: what matters is that the value travels.
   */
  it("reports the compiler options the caller asked to be checked under", async () => {
    const loose = await session.client.callTool({
      name: "generate_pattern",
      arguments: {
        pattern: "result",
        identifiers: { entity: "Order" },
        conventions: { strictness: "loose" },
      },
    });
    const strictest = await session.client.callTool({
      name: "generate_pattern",
      arguments: {
        pattern: "result",
        identifiers: { entity: "Order" },
        conventions: { strictness: "strictest" },
      },
    });

    expect(bundleOf(loose.structuredContent).verification.compilerOptions).toMatchObject({
      strict: false,
    });
    expect(bundleOf(strictest.structuredContent).verification.compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
    });
  }, 120_000);

  it("emits an example and a test as separate files", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "result", identifiers: { entity: "Order" } },
    });

    const roles = bundleOf(result.structuredContent).files.map((file) => file.role);
    expect(roles).toContain("example");
    expect(roles).toContain("test");
  }, 120_000);
});

describe("a bundle with no tests in it", () => {
  it("reports skipped, and never an outcome implying tests passed", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: {
        pattern: "result",
        identifiers: { entity: "Order" },
        includeTests: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const bundle = bundleOf(result.structuredContent);
    expect(bundle.verification.testOutcome).toBe("skipped");
    expect(bundle.files.map((file) => file.role)).not.toContain("test");
  }, 120_000);

  it("says so in nextSteps, so the weaker guarantee is stated and not inferred", async () => {
    // `skipped` is a field an agent has to know to read. The difference between "this compiles" and
    // "this compiles and its tests were run" is the whole of Principle III, so it is said in words.
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: {
        pattern: "result",
        identifiers: { entity: "Order" },
        includeTests: false,
      },
    });

    const bundle = bundleOf(result.structuredContent);
    expect(bundle.nextSteps.join("\n")).toContain("includeTests");
    expect(bundle.nextSteps.join("\n")).toMatch(/nothing in it has been run/);
  }, 120_000);
});

/**
 * `verbosity` governs the readable block and nothing else (contracts/mcp-tools.md).
 *
 * The distinction these hold in place: a terser rendering is a terser *description*, so the structured
 * result is complete at every setting and only the text changes. An implementation that dropped files
 * from `structuredContent` under `summary` would pass a naive reading of "omits file contents" while
 * making the response lossy.
 */
describe("verbosity", () => {
  const args = { pattern: "result", identifiers: { entity: "Order" } };

  it("omits file contents from the summary text while still naming every file", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { ...args, verbosity: "summary" },
    });

    const text = textOf(result);
    expect(text).toContain("order-result.ts");
    expect(text).not.toContain("export type OrderResult");
    expect(text).toContain("verbosity `full`");
  }, 120_000);

  it("keeps the structured result complete when the text is summarised", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { ...args, verbosity: "summary" },
    });

    const bundle = bundleOf(result.structuredContent);
    expect(bundle.files.length).toBeGreaterThan(0);
    for (const file of bundle.files) expect(file.contents.length).toBeGreaterThan(0);
  }, 120_000);

  it("gives code-only the code without the prose", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { ...args, verbosity: "code-only" },
    });

    const text = textOf(result);
    expect(text).toContain("export type OrderResult");
    expect(text).not.toContain("### Next steps");
    expect(text).not.toContain("### Notes");
  }, 120_000);
});

/**
 * A `core-only` bundle is the one case where what was returned cannot be used as it stands: it is
 * machinery with nothing bound to it. So the call that finishes the job is spelled out, with its
 * arguments, rather than left for the caller to reconstruct from the options table.
 */
describe("a core-only bundle", () => {
  it("names the binding-only call that completes it, and does so at every verbosity", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: {
        pattern: "repository",
        identifiers: { entity: "Order" },
        emitScope: "core-only",
        verbosity: "summary",
      },
    });

    const bundle = bundleOf(result.structuredContent);
    const steps = bundle.nextSteps.join("\n");
    expect(steps).toContain("binding-only");
    expect(steps).toContain("coreModule");
    // The specifier follows the caller's import convention, so it is quotable as written.
    expect(steps).toContain("./repository-core.js");

    // Summary omits contents, not guidance: hiding this step would hide the only thing left to do.
    expect(textOf(result)).toContain("binding-only");
  }, 120_000);
});

describe("a full split-capable bundle", () => {
  it("says how to add a second type without a second copy of the core", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "repository", identifiers: { entity: "Order" } },
    });

    expect(bundleOf(result.structuredContent).nextSteps.join("\n")).toContain("binding-only");
  }, 120_000);

  it("says nothing of the sort for a pattern that does not split", async () => {
    // `result` emits one module, so there is no scope to choose and no second call to suggest. An
    // unconditional step here would be advice a caller cannot act on.
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "result", identifiers: { entity: "Order" } },
    });

    expect(bundleOf(result.structuredContent).nextSteps).toEqual([]);
  }, 120_000);
});
