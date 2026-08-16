import { defineConfig } from "vitest/config";

const suites = ["unit", "contract", "golden", "determinism", "parity", "conformance"] as const;

export default defineConfig({
  test: {
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
