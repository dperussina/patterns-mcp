/**
 * The economy of applying a pattern to a second type (SC-004, US3).
 *
 * The claim under test is the reason the split exists: a project with eleven entities should pay for the
 * machinery once. If the twelfth binding costs anything close to a full bundle, the option is a
 * rearrangement rather than a saving, and a caller is better off ignoring it.
 *
 * Measured over the protocol and in characters of response content, because that is the cost a caller
 * actually bears — tokens through a model, bytes over a transport — rather than a file count, which would
 * report a saving of two-thirds for a bundle that shrank by nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect } from "./client.js";
import type { Session } from "./client.js";

/** SC-004's threshold: a binding is at most a fifth of the full bundle. */
const BUDGET = 0.2;

let session: Session;

beforeAll(async () => {
  session = await connect();
});

afterAll(async () => {
  await session.close();
});

interface Bundle {
  readonly files: readonly { readonly path: string; readonly contents: string }[];
}

async function bytesOf(options: Readonly<Record<string, unknown>>): Promise<number> {
  const result = await session.client.callTool({
    name: "generate_pattern",
    arguments: { pattern: "repository", identifiers: { entity: "Order" }, options },
  });

  expect(result.isError).toBeFalsy();

  const bundle = result.structuredContent as Bundle;
  return bundle.files.reduce((total, file) => total + file.contents.length, 0);
}

describe("adding a pattern to another type when the machinery exists", () => {
  it("costs a fraction of the original request", async () => {
    const full = await bytesOf({});
    const binding = await bytesOf({
      emitScope: "binding-only",
      coreModule: "./repository-core.js",
    });

    // Reported rather than only asserted: a threshold that is nearly breached and a threshold that is
    // met by an order of magnitude are the same green tick, and only one of them is worth knowing about.
    const ratio = binding / full;
    expect(ratio, `binding-only is ${(ratio * 100).toFixed(1)}% of the full bundle`).toBeLessThanOrEqual(
      BUDGET,
    );
  }, 180_000);

  it("saves the machinery rather than the tests", async () => {
    // The distinction the ratio alone would hide. Dropping a suite shrinks a response and buys a caller
    // nothing, so the comparison is against a full bundle that has no suite either: what remains has to
    // be the machinery, which is the thing being reused.
    const fullWithoutTests = await bytesOf({ includeTests: false });
    const binding = await bytesOf({
      emitScope: "binding-only",
      coreModule: "./repository-core.js",
      includeTests: false,
    });

    expect(binding / fullWithoutTests).toBeLessThanOrEqual(BUDGET);
  }, 180_000);
});
