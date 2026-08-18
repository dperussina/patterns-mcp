/**
 * A signalled binary takes its compiler with it.
 *
 * The verifier holds a `tsc` subprocess, and the only thing that ends it is `disposeEngine`. Every exit
 * path called that except the one hosts actually use — a signal — so stopping the server stranded the
 * compiler, reparented to init, holding its resident set forever. This machine accumulated 38 of them,
 * 261MB between them, before anything noticed; CI noticed from the other end, where the whole gate passed
 * and the job then sat for 73 minutes because an orphan still held the runner's output pipe.
 *
 * Spawned for real, which this suite otherwise avoids. The claim is about what survives a process, so
 * there is nothing to assert in-process: a test that called the handler directly would prove the handler
 * runs, which was never in doubt, rather than that the child is gone afterwards.
 *
 * Source rather than `dist`, through `tsx`, so this runs before the build like the rest of the suite.
 *
 * `node --import tsx` rather than the `tsx` command, which matters more than it looks. The command is a
 * launcher that spawns node as a child, so the signal lands on the launcher and the compiler ends up a
 * grandchild of the thing being signalled — and the launcher tears down its process group on the way out,
 * which reaped the compiler and made this test pass against the very bug it was written for. Loading the
 * hook into one process reproduces what a host actually spawns.
 */

import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ChildProcess } from "node:child_process";

const ROOT = join(import.meta.dirname, "..", "..");

/** How long a compiler may take to appear, and then to go away. Measured at a few seconds, and instant. */
const APPEAR_MS = 30_000;
const VANISH_MS = 15_000;

interface Binary {
  readonly name: string;
  readonly entry: string;
  readonly argv: readonly string[];
}

const BINARIES: readonly Binary[] = [
  { name: "the stdio server", entry: "src/mcp/transports/stdio-bin.ts", argv: [] },
  { name: "the remote server", entry: "src/mcp/transports/http-bin.ts", argv: ["--port", "0"] },
];

/**
 * Every process descended from `pid`, at any depth.
 *
 * `ps` rather than a Node API, for the reason the retention script uses it too: the compiler is a
 * subprocess and nothing inside this process can see it. The whole table is read and the tree walked,
 * because the compiler is a grandchild — the binary spawns the engine's verifier, which spawns `tsc`.
 */
function descendants(pid: number): readonly { readonly pid: number; readonly command: string }[] {
  const table = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8" });

  const rows = table
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parent: Number(match[2]),
      command: match[3] ?? "",
    }));

  const found: { pid: number; command: string }[] = [];
  let frontier = [pid];

  while (frontier.length > 0) {
    const children = rows.filter((row) => frontier.includes(row.parent));
    found.push(...children.map((row) => ({ pid: row.pid, command: row.command })));
    frontier = children.map((row) => row.pid);
  }

  return found;
}

/** The compilers a binary is holding, identified by the verification root only the engine passes. */
function compilersUnder(pid: number): readonly number[] {
  return descendants(pid)
    .filter((row) => row.command.includes("tsc") && row.command.includes("--cwd /verify"))
    .map((row) => row.pid);
}

/** Whether a process still exists. Signal zero checks for it without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

describe.each(BINARIES)("$name, when it is signalled", (binary) => {
  it(
    "leaves no compiler behind",
    async () => {
      const child: ChildProcess = spawn(
        process.execPath,
        ["--import", "tsx", join(ROOT, binary.entry), ...binary.argv],
        // The repository, not a temporary directory: `--import tsx` resolves that specifier against the
        // working directory, and from anywhere else the process exits before it can start a compiler.
        // Running from elsewhere is `smoke-packaged.ts`'s job, and it is a claim about path resolution
        // rather than about signals.
        { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
      );

      const server = child.pid;
      expect(server, "the binary did not start").toBeDefined();
      if (server === undefined) return;

      try {
        // Both transports warm the engine on startup, so a compiler appears without being asked for one.
        // Waiting for it is also what keeps this test honest: if none ever appeared, everything below
        // would pass while proving nothing.
        const appeared = await until(() => compilersUnder(server).length > 0, APPEAR_MS);
        const compilers = compilersUnder(server);
        expect(appeared, "no compiler was ever started, so this proves nothing").toBe(true);
        expect(compilers.length).toBeGreaterThan(0);

        child.kill("SIGTERM");

        await until(() => !alive(server), VANISH_MS);
        expect(alive(server), "the binary ignored SIGTERM").toBe(false);

        const survived = await until(() => compilers.every((pid) => !alive(pid)), VANISH_MS);
        expect(
          survived,
          `orphaned compilers: ${compilers.filter(alive).join(", ")}`,
        ).toBe(true);
      } finally {
        // Belt and braces: a failure here must not add to the pile this test exists to prevent.
        for (const pid of compilersUnder(server)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone, which is the outcome the test wants anyway.
          }
        }
        child.kill("SIGKILL");
      }
    },
    APPEAR_MS + 4 * VANISH_MS,
  );
});
