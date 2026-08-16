/**
 * Executing the tests we generated.
 *
 * Principle III requires that a bundle containing tests has those tests run before it is returned, so
 * this is not optional. FR-034 requires that caller-supplied content is never executed, which is why
 * the input here is a generated bundle: our templates, with identifiers already validated against an
 * allowlist. Nothing a caller wrote reaches a subprocess.
 *
 * Two things about the mechanism are non-obvious and were measured rather than assumed.
 *
 * **Why each file runs on its own, instead of `node --test`.** The test runner's `--test` mode spawns
 * a child process per file, which the permission model denies unless `--allow-child-process` is
 * granted — and granting it would hand the sandboxed code the ability to spawn anything it liked.
 * Invoking each file directly keeps that door shut, because the spawn happens out here where it is
 * ours to control.
 *
 * **Why the bundle is transpiled first.** Under the default conventions a bundle imports `./thing.js`
 * while the file on disk is `thing.ts`. TypeScript resolves that pairing happily; Node does not, and
 * reports `ERR_MODULE_NOT_FOUND`. So the bundle would typecheck and then fail to run for a reason
 * that has nothing to do with the code. Transpiling to CommonJS with
 * `rewriteRelativeImportExtensions` makes all three extension conventions — `.js`, `.ts`, and
 * extensionless — resolve, which was verified for each.
 *
 * **Why the network is closed here rather than left to the permission model.** It was assumed to be
 * covered and is not: `--permission` governs the filesystem, child processes, workers and native addons,
 * and says nothing about sockets. Measured rather than reasoned about — a probe run with exactly the flags
 * below resolved a real DNS name and imported `node:net` without complaint. Since FR-034 now permits a
 * declaring pattern to emit code that reaches the network, the tests for those patterns are the ones most
 * worth pinning: they are supposed to pass a fake transport in and never dial. `DENY_NETWORK` makes the
 * difference between "does not" and "cannot".
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript-stable";

import { UnsupportedRuntimeError } from "../errors.js";
import { MINIMUM_NODE, runtimeSupported } from "./runtime.js";
import { bareRequires, shimFilesFor } from "./test-shims.js";

import type { BundleFile } from "./typecheck.js";

/** `skipped` means there was nothing to run. A failure is never a returnable state (FR-005). */
export type TestOutcome = "passed" | "failed" | "skipped";

export interface TestRunResult {
  readonly outcome: TestOutcome;
  /**
   * Captured output for the failing file, present only on failure. A failure here is an internal
   * defect, so this is for our diagnosis and must not be passed to a caller verbatim (FR-038).
   */
  readonly detail: string | undefined;
}

export interface TestRunRequest {
  readonly files: readonly BundleFile[];
  /** Which of `files` are test entry points. Empty means there is nothing to execute. */
  readonly testPaths: readonly string[];
  /**
   * Files written byte-for-byte instead of transpiled — a `package.json` placing a synthesised core
   * behind a bare specifier (`synthesize-core.ts`). Separate from `files` because transpiling JSON
   * produces a syntactically valid JavaScript expression and a `package.json` that no longer parses.
   */
  readonly verbatimFiles?: readonly BundleFile[];
  readonly timeoutMs?: number;
}

/** Generous for tests that should finish in milliseconds; present so a runaway cannot hang a request. */
const DEFAULT_TIMEOUT_MS = 5_000;

export async function runGeneratedTests(request: TestRunRequest): Promise<TestRunResult> {
  if (request.testPaths.length === 0) return { outcome: "skipped", detail: undefined };

  // Checked here rather than at the spawn: below this line the sandbox is the only thing standing
  // between generated code and the filesystem, and a runtime that cannot enforce it must stop the
  // request instead of reporting whatever the child happened to print. The order also matters —
  // ahead of the temporary directory, so nothing is written for a run that cannot proceed.
  if (!runtimeSupported()) {
    throw new UnsupportedRuntimeError(MINIMUM_NODE, process.versions.node);
  }

  const missing = request.testPaths.filter(
    (path) => !request.files.some((file) => file.path === path),
  );
  if (missing.length > 0) {
    // Our own assembly is inconsistent; say so rather than reporting a test failure.
    throw new Error(`Test entry points absent from the bundle: ${missing.toSorted().join(", ")}`);
  }

  for (const file of [...request.files, ...(request.verbatimFiles ?? [])]) {
    assertSafePath(file.path);
  }

  // realpath matters: on macOS the temp directory is reached through a symlink, and the permission
  // model checks the resolved path. Granting the unresolved one denies every read.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pattern-verify-")));
  try {
    await materialise(directory, request.files, request.verbatimFiles ?? []);
    return await execute(directory, request.testPaths, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Preloaded into every sandboxed run, replacing each network entry point with one that throws.
 *
 * CommonJS because the sandbox declares `type: commonjs`, which is also what makes this effective rather
 * than decorative: every bundle is transpiled to `require`, so patching the exports object a builtin
 * hands out is patching the only copy the generated code can reach. An ESM sandbox would have frozen
 * namespace objects and this would need a loader hook, which the permission model denies because
 * registering one spawns a worker.
 *
 * The list is entry points, not modules, and specifically not classes. An earlier version replaced
 * `net.Socket` and `tls.TLSSocket` outright and broke every run with `Class extends value () => {}`:
 * Node's own test runner reaches those constructors on the way to writing its output, so removing them
 * denies the sandbox its stdout rather than its network. Constructing a socket is harmless anyway —
 * connecting is the act — so `Socket.prototype.connect` is closed and the class is left alone.
 */
const DENY_NETWORK = `
const deny = (what) => () => {
  throw new Error("Verification denies network access, and " + what + " was called.");
};

globalThis.fetch = deny("fetch");

for (const [id, names] of [
  ["node:net", ["connect", "createConnection"]],
  ["node:tls", ["connect"]],
  ["node:http", ["request", "get"]],
  ["node:https", ["request", "get"]],
  ["node:http2", ["connect"]],
  ["node:dgram", ["createSocket"]],
  ["node:dns", ["lookup", "resolve", "resolve4", "resolve6"]],
]) {
  const loaded = require(id);
  for (const name of names) {
    try {
      loaded[name] = deny(id + "." + name);
    } catch {
      // A future runtime may make one of these non-writable. Losing one entry point is not a reason to
      // fail verification, and every other one is still closed.
    }
  }
}

// The method, not the constructor. This is what \`new Socket().connect()\` and every wrapper around it
// eventually reaches, including the ones the entry points above would have gone through.
for (const [id, holder] of [["node:net", "Socket"], ["node:tls", "TLSSocket"]]) {
  try {
    require(id)[holder].prototype.connect = deny(id + "." + holder + ".connect");
  } catch {
    // As above: a shape we did not expect is not a reason to refuse to verify.
  }
}
`;

/** Named with a leading underscore so it sorts away from bundle files and cannot be mistaken for one. */
const DENY_NETWORK_PATH = "_deny-network.cjs";

/** Rejects anything that could write outside the sandbox. Paths are ours, so this is a backstop. */
function assertSafePath(path: string): void {
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    throw new Error(`Unsafe bundle path: ${JSON.stringify(path)}`);
  }
}

async function materialise(
  directory: string,
  files: readonly BundleFile[],
  verbatim: readonly BundleFile[],
): Promise<void> {
  // CommonJS, so that an extensionless specifier resolves; ESM has no extension search.
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
  await writeFile(join(directory, DENY_NETWORK_PATH), DENY_NETWORK);

  const required = new Set<string>();

  for (const file of verbatim) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents);
  }

  for (const file of files) {
    const transpiled = transpile(file);
    for (const specifier of bareRequires(transpiled)) {
      required.add(specifier);
    }
    const target = join(directory, toJsPath(file.path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, transpiled);
  }

  // A suite written for the caller's runner needs that runner to resolve, and the sandbox has no
  // node_modules by design. Supplying a shim from inside it keeps the boundary closed while still
  // executing the caller's own test bytes (see test-shims.ts).
  for (const [path, contents] of shimFilesFor([...required])) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function transpile(file: BundleFile): string {
  return ts.transpileModule(file.contents, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      // Turns `./thing.ts` into `./thing.js`, so a bundle written for a bundler still runs here.
      rewriteRelativeImportExtensions: true,
    },
    fileName: file.path,
  }).outputText;
}

function toJsPath(path: string): string {
  return path.replace(/\.ts$/, ".js");
}

async function execute(
  directory: string,
  testPaths: readonly string[],
  timeoutMs: number,
): Promise<TestRunResult> {
  // Sorted, so which failure is reported first does not depend on caller ordering.
  for (const testPath of testPaths.toSorted(compare)) {
    const failure = await runOne(directory, toJsPath(testPath), timeoutMs);
    if (failure !== undefined) return { outcome: "failed", detail: `${testPath}: ${failure}` };
  }
  return { outcome: "passed", detail: undefined };
}

/** Resolves to a description of the failure, or `undefined` when the file passed. */
function runOne(directory: string, testPath: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        // Denies filesystem writes, child processes, and native addons for the code being run.
        "--permission",
        `--allow-fs-read=${directory}`,
        // Closes what the flag above leaves open. See DENY_NETWORK.
        "--require",
        join(directory, DENY_NETWORK_PATH),
        join(directory, testPath),
      ],
      {
        cwd: directory,
        // Deliberately empty: the sandbox inherits no configuration, no tokens, no NODE_OPTIONS.
        env: {},
        timeout: timeoutMs,
        // SIGKILL rather than SIGTERM, because a busy loop can decline to notice a polite request.
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(undefined);
          return;
        }
        const killed = (error as { killed?: boolean }).killed === true;
        resolve(
          killed
            ? `timed out after ${timeoutMs}ms`
            : summarise(`${stdout}${stderr}`) ?? error.message,
        );
      },
    );
  });
}

/**
 * The first failing assertion, in preference to the whole TAP stream. A verification failure is an
 * internal defect and someone has to read this.
 */
function summarise(output: string): string | undefined {
  const lines = output.split("\n");
  const notOk = lines.findIndex((line) => line.trimStart().startsWith("not ok"));
  if (notOk === -1) {
    const error = lines.find((line) => line.includes("Error:"));
    return error?.trim();
  }
  return lines
    .slice(notOk, notOk + 8)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
