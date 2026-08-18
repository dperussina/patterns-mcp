/**
 * Runs the official conformance suite against the remote transport (SC-011, T083).
 *
 * Wired as `pnpm conformance:http`. It could not be written before the HTTP transport existed: the runner
 * reaches an implementation over `--url` and has no stdio target, which is what blocked this task while
 * stdio was the only transport shipped.
 *
 * Starts the server on an arbitrary free port, hands the runner its URL, and stops it again — rather than
 * asking whoever runs the gate to have a server already up, which would make the result depend on which
 * build that server happened to be.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

import { serveHttp } from "../src/mcp/transports/http.js";

const BASELINE = join(import.meta.dirname, "..", "conformance-expected-failures.yaml");

const args = process.argv.slice(2);

// Port zero, so a machine already serving 3000 — a developer's own instance, another CI job — does not turn
// a conformance result into a port collision.
const handle = await serveHttp({ port: 0, log: (line) => process.stderr.write(`server: ${line}\n`) });
const url = `http://127.0.0.1:${String(handle.port)}/mcp`;

process.stderr.write(`conformance: testing ${url}\n`);

/**
 * The baseline is passed unless the caller named a single scenario.
 *
 * With it, the runner's verdict becomes the one worth gating on: a scenario failing outside the baseline
 * fails the run, and — the half that keeps the file honest — a scenario inside it that starts passing also
 * fails the run, forcing the entry to be deleted rather than left to accumulate. A single `--scenario` run is
 * how a failure gets read, and comparing one result against a whole baseline would report every other entry
 * as stale.
 */
const baseline = args.includes("--scenario") ? [] : ["--expected-failures", BASELINE];

const runner = spawn(
  "npx",
  [
    "conformance",
    "server",
    "--url",
    url,
    ...baseline,
    ...(args.length > 0 ? args : ["--suite", "active"]),
  ],
  { stdio: "inherit" },
);

const code = await new Promise<number | null>((resolve) => {
  runner.on("exit", resolve);
});

await handle.close();

// The runner's own verdict, passed through. A wrapper that swallowed it would make the gate report success
// for a suite that failed.
process.exitCode = code ?? 1;
