import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/mcp/transports/stdio-bin.ts",
    "src/mcp/transports/http-bin.ts",
    "src/cli/bin.ts",
  ],
  // ESM only, which is a narrower promise than the default and a deliberate one. A second format was
  // being emitted because tsdown emits two by default, not because anything asked for it: both binaries
  // are `.mjs`, and no test in the repository had ever loaded the CommonJS copy. Publishing 2.9 MB that
  // nothing verifies is worse than not publishing it. `engines.node` is 22.13, where `require()` of an ESM
  // graph without top-level await works unflagged, so a CommonJS caller is still served by the one build
  // — asserted against the built artifact in `scripts/smoke-packaged.ts` rather than assumed here.
  format: ["esm"],
  dts: true,
  // No source maps in the published artefact. They roughly double what a caller downloads to run a
  // generator they will never step through — and the one debugging session they would help with is ours,
  // where the source is at hand anyway. `package.json` ships `dist` wholesale, so leaving them emitted
  // meant publishing them.
  sourcemap: false,
  clean: true,
  treeshake: true,
  // Matches `engines.node`. It said `node20` while the server refused to run on Node 20 (FR-053), so the
  // bundler was down-levelling syntax for a runtime that could not start the program.
  target: "node22.13",
});
