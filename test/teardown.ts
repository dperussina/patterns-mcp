/**
 * Releases the shared compiler when a test file finishes (T028).
 *
 * `generate()` keeps one warm compiler subprocess for the life of the module registry, which is what
 * makes a check cost ~13ms instead of ~130ms. The subprocess is an active handle, so a worker that has
 * called `generate()` has nothing left to do and still will not exit: Vitest reports that something is
 * preventing the main process from exiting, and killing the run leaves orphaned `tsc --api` processes
 * behind. Four of them survived their dead parents before this existed.
 *
 * Per file rather than per run, because Vitest isolates the module registry per test file: each file
 * that generates gets its own compiler, so a single teardown at the end of the run would release only
 * the last one. Nothing is lost — the instance was never shared across files to begin with.
 *
 * A setup file rather than a rule for suites to follow, because forgetting is silent. The suite that
 * forgot still passes, and the cost surfaces as a hung run in whichever file happens to be last.
 */

import { afterAll } from "vitest";

afterAll(async () => {
  // Imported here rather than at the top of the file, and this is not a style choice. A setup file runs
  // before the test file, so a static import would load the engine — and the whole pattern graph behind
  // it — before `vi.mock` had a chance to replace anything, silently defeating every suite that mocks a
  // pattern module. Six of them, when this was written the obvious way.
  const { disposeEngine } = await import("../src/engine/generate/index.js");
  await disposeEngine();
});
