#!/usr/bin/env node
/**
 * The `patterns` executable.
 *
 * Separate from `run.ts` for the same reason the MCP transport's binary is separate from its server:
 * importing the CLI to test it must not run it. This file is the only part that touches the process — its
 * arguments, its streams, its exit code, and the engine's compiler subprocess, which has to be disposed
 * or the process hangs after printing (T028).
 */

import { disposeEngine } from "../engine/generate/index.js";
import { disposeOnSignal } from "../lifecycle.js";
import { EXIT, run } from "./run.js";

/**
 * Wrapped in a function rather than written as top-level `await`, which is what this was.
 *
 * The package is built for both module formats, and top-level await has no CommonJS equivalent — so the
 * bundler refused the file outright, and the CLI could not be built at all. A `main` that is called is
 * the shape the MCP binary next door already uses, for the same reason.
 */
async function main(): Promise<void> {
  let code: number = EXIT.INTERNAL;

  // The `finally` below covers a command that finishes. Ctrl-C during a generation does not reach it, and
  // that is the likeliest way this program ends: verification is the slow part, so it is what a caller
  // interrupts.
  disposeOnSignal(disposeEngine);

  try {
    code = await run(process.argv.slice(2), {
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
    });
  } finally {
    await disposeEngine();
  }

  // Assigned rather than passed to `process.exit`, so that buffered stdout is flushed before the process
  // ends. `process.exit` truncates a large `--json` payload on a piped stdout, which would hand a script
  // invalid JSON and no indication of why.
  process.exitCode = code;
}

// `catch` rather than `void`, because an unhandled rejection here would print a stack and exit 1 — a
// caller told their request was malformed when in fact the program failed before reading it.
main().catch((error: unknown) => {
  process.stderr.write(
    `patterns failed before it could run. This is a defect in the tool.\n${String(error)}\n`,
  );
  process.exitCode = EXIT.INTERNAL;
});
