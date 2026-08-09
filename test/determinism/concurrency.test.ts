/**
 * Two requests in flight at once must not be able to influence each other.
 *
 * This is not an abstract worry. The compiler instance and Prettier are warmed once and shared, and
 * the compiler's file system is *mutable* — each check replaces its contents. Interleaved requests
 * therefore write to the same virtual file system, and the failure this file is looking for is one
 * request being verified against another's files, which would let a bundle that does not compile be
 * returned as though it did (contracts/engine-api.md §5, Principle VII).
 */

import { describe, expect, it } from "vitest";

import { generate } from "../../src/engine/generate/index.js";

async function bundleFor(entity: string, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await generate({ pattern: "result", identifiers: { entity }, ...extra });
  return JSON.stringify(result.files.map((file) => [file.path, file.contents]));
}

describe("simultaneous requests", () => {
  it(
    "give each caller the bundle they asked for",
    async () => {
      const entities = ["Order", "Invoice", "Customer", "Shipment", "Payment"];

      const concurrent = await Promise.all(entities.map(async (entity) => await bundleFor(entity)));

      // The comparison is against the same requests run one at a time. Asserting only that the
      // concurrent results differ from each other would pass even if every one of them were wrong.
      const sequential: string[] = [];
      for (const entity of entities) {
        sequential.push(await bundleFor(entity));
      }

      expect(concurrent).toEqual(sequential);
    },
    120_000,
  );

  it(
    "keeps conventions from leaking between them",
    async () => {
      // Conventions become compiler options, and compiler options live in the shared virtual file
      // system's tsconfig. Two requests with different ones are the sharpest test of that boundary.
      const [strict, loose, esm, cjs] = await Promise.all([
        bundleFor("Order", { conventions: { strictness: "strictest" } }),
        bundleFor("Order", { conventions: { strictness: "loose" } }),
        bundleFor("Order", { conventions: { moduleStyle: "esm", importExtensions: "js" } }),
        bundleFor("Order", { conventions: { moduleStyle: "cjs", importExtensions: "none" } }),
      ]);

      expect(strict).toBe(await bundleFor("Order", { conventions: { strictness: "strictest" } }));
      expect(loose).toBe(await bundleFor("Order", { conventions: { strictness: "loose" } }));
      expect(esm).not.toBe(cjs);
    },
    120_000,
  );

  it(
    "does not let one request's failure disturb another's success",
    async () => {
      // A refusal takes a different path out of the pipeline. If it left shared state behind — a
      // half-updated file system, say — the requests running alongside it would be the casualties.
      const outcomes = await Promise.allSettled([
        bundleFor("Order"),
        bundleFor("class"),
        bundleFor("Invoice"),
        generate({ pattern: "no-such-pattern" }),
        bundleFor("Customer"),
      ]);

      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "rejected",
        "fulfilled",
        "rejected",
        "fulfilled",
      ]);

      const [order, , invoice, , customer] = outcomes;
      expect(order.status === "fulfilled" && order.value).toBe(await bundleFor("Order"));
      expect(invoice.status === "fulfilled" && invoice.value).toBe(await bundleFor("Invoice"));
      expect(customer.status === "fulfilled" && customer.value).toBe(await bundleFor("Customer"));
    },
    120_000,
  );
});
