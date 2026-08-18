/**
 * Where a request's time goes, measured rather than asserted (SC-009, T095).
 *
 * The reason this exists is that the plan's performance figures were written before the shape of the work
 * was known, and one of them turns out to be unmeetable in principle rather than unmet in practice. The
 * measured split of a warm request is roughly:
 *
 *     typecheck    ~1ms      the plan's "under 5ms", comfortably
 *     format      18–61ms    Prettier, once per emitted file
 *     run tests  110–150ms   a Node subprocess per test file, inside the permission model
 *     ─────────────────────
 *     total      135–190ms
 *
 * Producing the code is not on that list because it does not register: templating and assembly are the
 * remainder, and the remainder is noise. **So verification is not a fraction of a request, it is
 * essentially the whole of it, and executing the generated tests is the dominant cost by an order of
 * magnitude.** That is the product working as intended — the proposition is the proof, and the only way to
 * make verification a small fraction of request time would be to verify less.
 *
 * What this suite therefore holds are the properties that are both true and load-bearing:
 *
 * 1. **Warming works**, so the first caller of a session is not paying an order of magnitude more than
 *    the second. Cold is ~130ms per check against ~1ms warm, and that gap is the entire reason the engine
 *    keeps a compiler.
 * 2. **The warm compiler is still warm**, which is the regression that has already happened once: an
 *    over-aggressive liveness deadline abandoned healthy compilers under load and every check went cold.
 *    Nothing else in the repository would notice, because a cold check returns the same answer.
 * 3. **Typechecking is not what a request costs**, which is the defensible half of SC-009 and the half the
 *    plan's own figure was about.
 *
 * Ceilings are deliberately far above the measured values. This runs on hosted runners with two workers
 * and a compiler subprocess per file, so a tight bound would fail on contention rather than on a
 * regression — and a benchmark that cries wolf is one that gets deleted. Each is set where only a real
 * loss of warmth could reach it.
 */

import { performance } from "node:perf_hooks";

import { afterAll, describe, expect, it } from "vitest";

import { formatSource, warmFormatter } from "../../src/engine/format/prettier.js";
import { createVerifier } from "../../src/engine/verify/index.js";
import { disposeEngine, generate, warmEngine } from "../../src/index.js";

/**
 * A warm typecheck of a real bundle, above which the compiler has stopped being warm.
 *
 * Measured at about 1ms and a cold check at about 130ms, so this discriminates between the two with room
 * for a runner an order of magnitude slower than a laptop.
 */
const WARM_CHECK_CEILING_MS = 50;

/** How much of a request typechecking may account for. Measured at about 1%. */
const TYPECHECK_SHARE = 0.25;

/** Odd, so the median is a sample rather than a mean of two. */
const RUNS = 5;

function median(samples: readonly number[]): number {
  return samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
}

async function elapsed(work: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

async function medianOf(work: () => Promise<unknown>, runs = RUNS): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) samples.push(await elapsed(work));
  return median(samples);
}

afterAll(async () => {
  await disposeEngine();
});

describe("keeping a compiler", () => {
  it("makes a check an order of magnitude cheaper than the first one", async () => {
    // A verifier of its own, because the point is the transition from cold to warm and the shared one has
    // already made it. Disposed here rather than in `afterAll`, since nothing else may use it.
    const verifier = createVerifier();

    try {
      const bundle = await generate({ pattern: "result", options: { includeTests: false } });
      expect(bundle.kind).toBe("bundle");
      if (bundle.kind !== "bundle") return;
      const files = bundle.files.map((file) => ({ path: file.path, contents: file.contents }));

      // The bundle's own resolved conventions, which are what the engine verified it under. Anything else
      // would be measuring a check the engine never performs.
      const conventions = bundle.resolvedConventions;
      const cold = await elapsed(async () => await verifier.check(files, conventions));
      const warm = await medianOf(async () => await verifier.check(files, conventions));

      // A third rather than a tenth: the measured ratio is over a hundred, and the assertion should fail
      // on the compiler being lost rather than on a runner having a bad second.
      expect(warm, `cold ${cold.toFixed(0)}ms, warm ${warm.toFixed(0)}ms`).toBeLessThan(cold / 3);
      expect(warm).toBeLessThanOrEqual(WARM_CHECK_CEILING_MS);
    } finally {
      await verifier.dispose();
    }
  }, 120_000);

  it("is what warmEngine buys, and calling it again costs nothing", async () => {
    // The property that lets an adapter call this without coordinating: both transports warm in the
    // background and a request may arrive during it, so a second call has to be a resolved promise rather
    // than a second compiler.
    await warmEngine();
    const again = await elapsed(async () => {
      await warmEngine();
    });

    expect(again, `a repeat warm took ${again.toFixed(0)}ms, so something was redone`).toBeLessThan(
      WARM_CHECK_CEILING_MS,
    );
  }, 120_000);

  it("warms again after a shutdown rather than resolving against a compiler that is gone", async () => {
    // The other half of the case above, and the reason it needs its own: the promise that makes a repeat
    // free has to be released when the compiler it warmed is. Held past disposal it would make this call
    // resolve instantly having warmed nothing, which no functional test would notice — the engine warms
    // lazily, so the next request would simply pay the cold cost that warming exists to have already paid.
    await warmEngine();
    await disposeEngine();

    const afterShutdown = await elapsed(async () => {
      await warmEngine();
    });

    // Asserted from below, which is the robust direction: starting a compiler cannot be done in under a
    // few milliseconds on any host, while a stale resolved promise cannot take longer than one.
    expect(
      afterShutdown,
      `warming after a shutdown took ${afterShutdown.toFixed(0)}ms, which is too fast to have happened`,
    ).toBeGreaterThan(WARM_CHECK_CEILING_MS / 2);
  }, 120_000);
});

describe("what a request spends its time on", () => {
  /**
   * Three patterns spanning the size range, because the split moves with the number of files: `result` is
   * the smallest bundle in the catalogue and `chat-model-port` the largest.
   */
  it.each(["result", "repository", "chat-model-port"])(
    "is not typechecking: %s",
    async (pattern) => {
      await warmEngine();
      const verifier = createVerifier();
      await Promise.all([verifier.warm(), warmFormatter()]);

      try {
        const total = await medianOf(async () => await generate({ pattern }));

        const bundle = await generate({ pattern });
        expect(bundle.kind).toBe("bundle");
        if (bundle.kind !== "bundle") return;
        const files = bundle.files.map((file) => ({ path: file.path, contents: file.contents }));

        const conventions = bundle.resolvedConventions;
        const typecheck = await medianOf(async () => await verifier.check(files, conventions));
        const format = await medianOf(
          async () =>
            await Promise.all(
              files.map(
                async (file) => await formatSource(file.contents, conventions.prettierConfig),
              ),
            ),
        );

        // Printed rather than only asserted: the split is the finding this suite exists to keep visible,
        // and a number nobody sees is a number that drifts. `format` and the residual are reported and not
        // bounded, because the residual is dominated by executing the generated tests — the guarantee
        // itself, which there is no version of this product that makes cheap.
        console.info(
          `${pattern.padEnd(17)} total ${total.toFixed(0).padStart(4)}ms  ` +
            `typecheck ${typecheck.toFixed(1).padStart(5)}ms (${((typecheck / total) * 100).toFixed(1)}%)  ` +
            `format ${format.toFixed(0).padStart(3)}ms  ` +
            `tests and the rest ${(total - typecheck - format).toFixed(0).padStart(4)}ms`,
        );

        expect(
          typecheck / total,
          `typechecking ${pattern} took ${typecheck.toFixed(1)}ms of a ${total.toFixed(0)}ms request`,
        ).toBeLessThan(TYPECHECK_SHARE);
      } finally {
        await verifier.dispose();
      }
    },
    300_000,
  );
});
