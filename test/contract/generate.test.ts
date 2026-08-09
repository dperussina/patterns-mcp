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
}

interface Bundle {
  readonly kind: string;
  readonly pattern: string;
  readonly files: readonly { readonly path: string; readonly role: string }[];
  readonly verification: Verification;
  readonly resolvedOptions: Readonly<Record<string, unknown>>;
}

function bundleOf(structuredContent: unknown): Bundle {
  return structuredContent as Bundle;
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
    const text = (result.content as readonly { type: string; text?: string }[])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    expect(text).toContain("order-result.ts");
    expect(text).toContain("export type OrderResult");
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
});
