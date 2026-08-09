/**
 * Principle I, measured the only way that means anything: across process restarts.
 *
 * Comparing two calls inside one process proves much less than it appears to. A module-level cache, a
 * warmed compiler, a memoised catalog — all of them survive between calls and would make a
 * same-process comparison agree while the *first* call of a fresh process differed. Anything ambient
 * that varies per run, which is the failure mode this principle exists to prevent, only shows up when
 * the process is new.
 *
 * These spawns make this file slower than the rest of the suite. That is the cost of the assertion
 * being worth making (SC-002).
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const EMIT = fileURLToPath(new URL("./emit.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** One bundle, generated in a process of its own. */
async function emitInFreshProcess(
  request: Record<string, unknown>,
  environment: Record<string, string> = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", EMIT, JSON.stringify(request)],
      {
        cwd: ROOT,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...environment },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`emit failed: ${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const request = { pattern: "result", identifiers: { entity: "Order" } };

describe("byte-identical across process restarts", () => {
  it(
    "produces the same bytes in two separate processes",
    async () => {
      const [first, second] = await Promise.all([
        emitInFreshProcess(request),
        emitInFreshProcess(request),
      ]);
      expect(second).toBe(first);
      expect(first.length).toBeGreaterThan(500);
    },
    60_000,
  );

  it(
    "is unaffected by the environment the process was started in",
    async () => {
      // Not a hypothetical: reading configuration from the environment is the most common way a
      // generator becomes host-dependent, and it would not show up in any same-process comparison.
      const [plain, polluted] = await Promise.all([
        emitInFreshProcess(request),
        emitInFreshProcess(request, {
          TZ: "Pacific/Kiritimati",
          LANG: "tr_TR.UTF-8",
          LC_ALL: "tr_TR.UTF-8",
          NODE_ENV: "production",
          PATTERNS_STYLE: "compact",
        }),
      ]);
      expect(polluted).toBe(plain);
    },
    60_000,
  );

  it(
    "gives different bytes for a different request, so the comparison can fail",
    async () => {
      // Without this, every assertion above would also pass for a generator that returned a constant.
      const [order, invoice] = await Promise.all([
        emitInFreshProcess(request),
        emitInFreshProcess({ pattern: "result", identifiers: { entity: "Invoice" } }),
      ]);
      expect(invoice).not.toBe(order);
    },
    60_000,
  );

  it(
    "reaches the same content hash for the same request in a new process",
    async () => {
      const [first, second] = await Promise.all([
        emitInFreshProcess(request),
        emitInFreshProcess(request),
      ]);
      const a = JSON.parse(first) as { contentHash: string };
      const b = JSON.parse(second) as { contentHash: string };
      expect(b.contentHash).toBe(a.contentHash);
      expect(a.contentHash).toMatch(/^[0-9a-f]{16}$/);
    },
    60_000,
  );
});
