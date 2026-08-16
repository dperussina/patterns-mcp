import { defineConfig } from "vitest/config";

const suites = ["unit", "contract", "golden", "determinism", "parity", "conformance"] as const;

/**
 * How many test files run at once, and why CI gets a different answer.
 *
 * Each file that generates holds a compiler subprocess for its lifetime, and each generated suite is
 * executed by spawning another process, so the peak cost of a run is set by how many files are in flight
 * rather than by any one test. Left to itself Vitest sizes the pool from the CPU count, which is the right
 * default on a machine with headroom and the wrong one on a hosted runner: both Ubuntu jobs went silent
 * part-way through the golden suite and then reported that the runner had received a shutdown signal —
 * not a failing assertion anywhere, the machine simply stopped. macOS, with fewer workers and more memory
 * per worker, passed the same commit.
 *
 * Two is deliberately below what any hosted runner reports. It costs wall-clock and buys the property the
 * suite needs, which is finishing; and it removes the contention that made a healthy typecheck exceed a
 * ten-second liveness deadline, which was the first symptom of the same saturation.
 */
const maxWorkers = process.env.CI === undefined ? undefined : 2;

export default defineConfig({
  test: {
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    // No `passWithNoTests`. It was here while suites were still being populated, and it outlived that:
    // `parity` had no files at all, so `pnpm test parity` reported success for a comparison that was
    // never made — the one suite whose absence nothing else would have revealed, since every other
    // suite passes whether or not the two surfaces agree. A suite that loses its tests now fails.
    projects: suites.map((suite) => ({
      test: {
        name: suite,
        include: [`test/${suite}/**/*.test.ts`],
        // Every suite, because any of them may reach `generate()` transitively and the compiler
        // subprocess it holds would otherwise keep the worker alive (see test/teardown.ts).
        setupFiles: ["./test/teardown.ts"],
      },
    })),
  },
});
