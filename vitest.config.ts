import { defineConfig } from "vitest/config";

const suites = ["unit", "contract", "golden", "determinism", "parity"] as const;

export default defineConfig({
  test: {
    // Suites are populated over the course of implementation; without this, an
    // empty suite fails the whole run. Revisit once every suite has tests (T111).
    passWithNoTests: true,
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
