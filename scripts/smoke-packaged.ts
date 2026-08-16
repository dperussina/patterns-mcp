/**
 * Exercises the **built** server the way a host will. Wired into `pnpm check` as `pnpm smoke`.
 *
 * Every other stage of the gate runs against `src/`, which is why the gate once passed while the
 * published package was entirely non-functional: the catalogue and name table were located by a fixed
 * relative path from their own module, correct in the source tree and three levels too high once the
 * bundler flattened the directory structure. No unit test could see it. Running the artifact can.
 *
 * So this deliberately asserts the boring, end-to-end things a bundling or packaging mistake breaks:
 * that the binary starts, speaks the protocol, finds its own data, generates a verified bundle, keeps
 * stdout free of anything that is not a protocol frame, and says nothing on stderr when all is well.
 *
 * Launched from a temporary directory, not the repository, so that any path resolved relative to the
 * current working directory fails here rather than in a user's install.
 *
 * All three things `package.json` publishes are exercised, because for a while only one of them was: the
 * server binary, the `patterns` CLI binary, and the library entry loaded the way a CommonJS caller loads
 * it. The last of those is what makes dropping the second build format a tested claim instead of a hope.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DIST = join(import.meta.dirname, "..", "dist");
const BIN = join(DIST, "mcp", "transports", "stdio-bin.mjs");
const CLI = join(DIST, "cli", "bin.mjs");
const ENTRY = join(DIST, "index.mjs");
const PROTOCOL_VERSION = "2025-11-25";
const TIMEOUT_MS = 180_000;

interface Frame {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

function fail(message: string): never {
  process.stderr.write(`smoke: ${message}\n`);
  process.exit(1);
}

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "generate_pattern",
      arguments: { pattern: "result", identifiers: { entity: "Invoice" } },
    },
  },
];

const child = spawn(process.execPath, [BIN], {
  cwd: tmpdir(),
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk: string) => {
  stderr += chunk;
});

for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);

const timer = setTimeout(() => {
  child.kill("SIGKILL");
  fail(`the built server produced no answer within ${String(TIMEOUT_MS / 1000)}s`);
}, TIMEOUT_MS);

/** Resolves when the response to the generate call has arrived, or the child dies first. */
await new Promise<void>((resolve) => {
  const settled = (): void => {
    if (stdout.includes('"id":2')) resolve();
  };
  child.stdout.on("data", settled);
  child.on("exit", () => {
    resolve();
  });
});

clearTimeout(timer);
child.stdin.end();
child.kill();

const lines = stdout.split("\n").filter((line) => line.trim() !== "");
if (lines.length === 0) fail(`the built server wrote nothing to stdout. stderr was:\n${stderr}`);

const frames: Frame[] = [];
for (const line of lines) {
  try {
    frames.push(JSON.parse(line) as Frame);
  } catch {
    // The whole point of routing diagnostics to stderr. A single stray write lands here.
    fail(`stdout carried something that is not a protocol frame: ${line.slice(0, 200)}`);
  }
}

const handshake = frames.find((frame) => frame.id === 1);
if (handshake?.result === undefined) {
  fail(`the handshake failed: ${JSON.stringify(handshake ?? null)}`);
}

const call = frames.find((frame) => frame.id === 2);
if (call?.result === undefined) fail(`no answer to the generate call. stderr was:\n${stderr}`);

if (call.result.isError === true) {
  fail(`generation was refused by the built server. stderr was:\n${stderr}`);
}

const structured = call.result.structuredContent as
  | {
      readonly files?: readonly unknown[];
      readonly verification?: { readonly diagnosticCount?: number; readonly testOutcome?: string };
    }
  | undefined;

if (structured?.verification === undefined) fail("the answer carried no verification evidence");
if (structured.verification.diagnosticCount !== 0) {
  fail(`the built server returned a bundle with diagnostics: ${JSON.stringify(structured.verification)}`);
}
if (structured.verification.testOutcome !== "passed") {
  fail(`generated tests did not pass: ${String(structured.verification.testOutcome)}`);
}
if ((structured.files?.length ?? 0) === 0) fail("the answer carried no files");

// Nothing is wrong, so nothing should have been reported. A warning here is worth seeing before a user
// sees it, since stderr is where a host surfaces server trouble.
if (stderr.trim() !== "") fail(`the built server complained on stderr:\n${stderr}`);

/** Runs node from a temporary directory and returns what it said. */
async function runNode(
  argv: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const run = spawn(process.execPath, argv, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  run.stdout.setEncoding("utf8");
  run.stderr.setEncoding("utf8");
  run.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  run.stderr.on("data", (chunk: string) => {
    err += chunk;
  });

  const code = await new Promise<number | null>((resolve) => {
    run.on("exit", resolve);
  });

  return { code, stdout: out, stderr: err };
}

// The CLI is a delivery surface in its own right (Principle X), and a bundling mistake breaks it
// independently of the server — they share an engine but not an entry point.
const listed = await runNode([CLI, "list", "--json"]);
if (listed.code !== 0) {
  fail(`the built CLI could not list patterns (exit ${String(listed.code)}). stderr was:\n${listed.stderr}`);
}

let listing: { readonly total?: number };
try {
  listing = JSON.parse(listed.stdout) as { readonly total?: number };
} catch {
  fail(`the built CLI wrote something other than JSON for --json: ${listed.stdout.slice(0, 200)}`);
}
if ((listing.total ?? 0) === 0) fail("the built CLI found no patterns, so it did not find its own catalogue");

// Loaded through `require` on purpose. This is the compatibility the single ESM build rests on, and the
// assertion that would fail first if a dependency ever introduced top-level await, which is the one thing
// `require()` of an ESM graph still cannot do. `node -e` is CommonJS, so `require` is the real one.
const required = await runNode([
  "-e",
  `const m = require(${JSON.stringify(ENTRY)}); if (typeof m.generate !== "function") throw new Error("no generate export");`,
]);
if (required.code !== 0) {
  fail(`the published entry cannot be require()d, so a CommonJS caller has nothing to load:\n${required.stderr}`);
}

process.stdout.write(
  `smoke: the built server generated ${String(structured.files?.length ?? 0)} verified files, tests passed; ` +
    `the CLI listed ${String(listing.total ?? 0)} patterns; the entry loads under require\n`,
);
