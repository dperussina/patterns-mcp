/**
 * How much memory one process accumulates over a long run of generations.
 *
 * Written because CI found the question rather than the answer: both Ubuntu jobs filled 16GB and stopped,
 * and capping the worker pool changed nothing, so the cost is retained across requests rather than held
 * concurrently. That distinction matters well beyond the suite — an MCP server is long-lived, and a cost
 * that accumulates per request is a server that dies on a schedule set by its own traffic.
 *
 * Reports this process and every descendant, because the compiler is a subprocess and its resident size
 * is invisible to `process.memoryUsage()`.
 *
 * Usage: pnpm tsx scripts/measure-retention.ts [generations]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { disposeEngine, generate } from "../src/engine/generate/index.js";
import { listPatterns } from "../src/index.js";

const run = promisify(execFile);

interface Resident {
  readonly pid: number;
  readonly megabytes: number;
  readonly command: string;
}

const sum = (rows: readonly Resident[]): number =>
  rows.reduce((total, row) => total + row.megabytes, 0);

/** Resident size of this process and all of its descendants, in megabytes. */
async function residentTree(): Promise<{
  total: number;
  own: number;
  children: number;
  heap: number;
  largest: string;
}> {
  // `ps` rather than a Node API: the compiler is a child process, and its pages are the ones in question.
  const { stdout } = await run("ps", ["-eo", "pid=,ppid=,rss=,comm="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .map(([pid, parent, rss, ...command]) => ({
      pid: Number(pid),
      parent: Number(parent),
      megabytes: Number(rss) / 1024,
      command: command.join(" "),
    }));

  const descendants = new Set([process.pid]);
  // Repeated passes rather than one, since `ps` does not order parents before children.
  for (let pass = 0; pass < rows.length; pass += 1) {
    let grew = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.parent)) {
        descendants.add(row.pid);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const mine = rows.filter((row) => descendants.has(row.pid));
  const children = mine.filter((row) => row.pid !== process.pid);
  const biggest = children.toSorted((a, b) => b.megabytes - a.megabytes)[0];

  return {
    total: sum(mine),
    own: sum(mine.filter((row) => row.pid === process.pid)),
    children: sum(children),
    heap: process.memoryUsage().heapUsed / 1024 / 1024,
    largest:
      biggest === undefined
        ? "(no children)"
        : `${biggest.command.split("/").at(-1) ?? "?"} ${biggest.megabytes.toFixed(0)}M`,
  };
}

const generations = Number(process.argv[2] ?? "60");
const patterns = (await listPatterns({ kind: "generative" })).map((pattern) => pattern.name);

console.log(`${String(generations)} generations across ${String(patterns.length)} patterns\n`);

const report = (label: string, now: Awaited<ReturnType<typeof residentTree>>, base = 0): void => {
  console.log(
    `${label.padStart(3)}  total ${now.total.toFixed(0).padStart(5)}M  ` +
      `(+${(now.total - base).toFixed(0).padStart(4)}M)  ` +
      `own ${now.own.toFixed(0).padStart(4)}M  heap ${now.heap.toFixed(0).padStart(4)}M  ` +
      `children ${now.children.toFixed(0).padStart(5)}M  largest child: ${now.largest}`,
  );
};

const start = await residentTree();
report("0", start, start.total);

for (let index = 0; index < generations; index += 1) {
  const pattern = patterns[index % patterns.length];
  if (pattern === undefined) continue;
  await generate({ pattern, options: { includeTests: false } });

  if ((index + 1) % 10 === 0) report(String(index + 1), await residentTree(), start.total);
}

await disposeEngine();
