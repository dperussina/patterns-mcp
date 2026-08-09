/**
 * Crash recovery lives in its own file because the only portable way to reach the compiler is by
 * process, and vitest gives each file its own worker. Scoping the kill to this process's own
 * children keeps it from reaching into a sibling suite's warm compiler.
 *
 * One failure mode is deliberately *not* tested here, because it cannot be survived: issuing a
 * request in the same tick as the kill, before Node has processed the stream teardown, throws
 * ERR_STREAM_DESTROYED from inside the vendored JSON-RPC writer. That rejection is unhandled and
 * fatal, and there is no seam for us to catch it. Recorded in blockers.md; anything from ~100ms
 * after the death onward recovers cleanly, which covers a compiler that dies on its own.
 */

import { execSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONVENTIONS } from "../../src/engine/options/conventions.js";
import { Typechecker } from "../../src/engine/verify/typecheck.js";
import type { BundleFile } from "../../src/engine/verify/typecheck.js";

const files: BundleFile[] = [{ path: "index.ts", contents: "export const x: number = 1;\n" }];

/** Kills this process's children only, so a parallel suite keeps its compiler. */
function killOwnChildren(): number {
  const pids = execSync(`pgrep -P ${process.pid} || true`)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const pid of pids) {
    try {
      execSync(`kill -9 ${pid}`);
    } catch {
      // Already gone.
    }
  }
  return pids.length;
}

describe("crash recovery", () => {
  it("recovers when the compiler subprocess dies", async () => {
    const checker = new Typechecker();
    try {
      expect((await checker.check(files, DEFAULT_CONVENTIONS)).diagnostics).toEqual([]);

      expect(killOwnChildren()).toBeGreaterThan(0);
      // Let Node observe the closed socket, so the next request rejects rather than writing into a
      // stream that is already destroyed.
      await new Promise((resolve) => setTimeout(resolve, 250));

      // The rejection is infrastructural, so one retry against a fresh compiler should absorb it.
      expect((await checker.check(files, DEFAULT_CONVENTIONS)).diagnostics).toEqual([]);

      // And the replacement is durable rather than single-use.
      expect((await checker.check(files, DEFAULT_CONVENTIONS)).diagnostics).toEqual([]);
      expect(
        (await checker.check(
          [{ path: "index.ts", contents: "export const x: string = 1;\n" }],
          DEFAULT_CONVENTIONS,
        )).diagnostics,
      ).toHaveLength(1);
    } finally {
      await checker.dispose();
    }
  }, 30_000);

  it("gives up rather than hanging when the deadline passes", async () => {
    // One millisecond cannot be met, so this exercises the deadline itself: it fires, the retry also
    // fails, and the caller gets an error instead of a promise that never settles.
    const impatient = new Typechecker({ timeoutMs: 1 });
    try {
      await expect(impatient.check(files, DEFAULT_CONVENTIONS)).rejects.toThrow(/exceeded 1ms/);
    } finally {
      await impatient.dispose();
    }
  }, 30_000);
});
