/**
 * The verification gate: nothing is returned to a caller until the compiler has seen it and had
 * nothing to say (Principle III).
 *
 * Three properties of the underlying API shape this module, all of them measured rather than assumed:
 *
 * 1. **Warm reuse is the whole game.** A cold check costs ~130ms; a warm one ~13ms. So a single
 *    long-lived instance is held and the file tree is swapped underneath it.
 * 2. **The compiler serves a stale result when it is not told what changed.** Swapping in a broken
 *    bundle without a change summary returned zero diagnostics — a bundle certified on the strength
 *    of a check that never ran. The change summary therefore comes from the file system itself, not
 *    from a caller who might forget.
 * 3. **Configuration is not reloaded by `invalidateAll`.** Changing `strict` and passing
 *    `invalidateAll: true` left the old options in force; only naming the tsconfig in `changed`
 *    picked them up. Since the summary is derived mechanically from the whole tree, the tsconfig is
 *    included whenever its content differs, which is precisely when it must be.
 *
 * The async API is mandatory rather than preferred: the sync variant is backed by a synchronous
 * native RPC and pins the event loop completely. Measured here, 15 sequential checks left 148
 * event-loop ticks; the sync variant records zero, and a server using it could not serve anything
 * concurrently.
 */

import { API } from "typescript/unstable/async";
import { version as compilerVersion } from "typescript";

import type { Conventions } from "../options/conventions.js";
import { createMutableVerificationFileSystem } from "./vfs.js";
import type { MutableVerificationFileSystem } from "./vfs.js";

/** The virtual root. Fixed, so the project stays open and warm across checks. */
const ROOT = "/verify";
const TSCONFIG_PATH = `${ROOT}/tsconfig.json`;

/**
 * Far above any legitimate check — ~130ms cold, ~13ms warm — and there only so a wedged compiler
 * cannot hold a request open forever. A dead subprocess does not always reject the pending request.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** How long a failed compiler is left alone before being closed. See `#abandon`. */
const ABANDON_GRACE_MS = 1_000;

export { compilerVersion };

export interface BundleFile {
  /** Relative, forward slashes, no `..` — enforced upstream, never caller-supplied (FR-033). */
  readonly path: string;
  readonly contents: string;
}

export interface VerificationDiagnostic {
  readonly code: number;
  readonly text: string;
  /** Bundle-relative path, or `undefined` for a project-wide diagnostic. */
  readonly path: string | undefined;
}

export interface TypecheckOutcome {
  readonly diagnostics: readonly VerificationDiagnostic[];
  /** The options actually verified against, for the verification record (FR-006, FR-025). */
  readonly compilerOptions: Readonly<Record<string, unknown>>;
  readonly compilerVersion: string;
}

/**
 * What both verification paths reduce to: given files and options, return diagnostics. The unstable
 * API is fast and the stable one is dependable, and the constitution permits the former only while
 * the latter exists behind it, so the two must stay interchangeable.
 */
export interface Verifier {
  warm(): Promise<void>;
  check(files: readonly BundleFile[], conventions: Conventions): Promise<TypecheckOutcome>;
  dispose(): Promise<void>;
}

/**
 * Compiler options derived from the caller's conventions, so verification runs under the settings the
 * caller compiles under rather than ours (FR-025). `noEmit` is ours and not negotiable: verification
 * asks a question, it does not produce artefacts.
 */
export function compilerOptionsFor(conventions: Conventions): Record<string, unknown> {
  return {
    ...strictnessOptions(conventions.strictness),
    ...moduleOptions(conventions.moduleStyle, conventions.importExtensions),
    target: "es2022",
    lib: conventions.runtime === "browser" ? ["es2022", "dom", "dom.iterable"] : ["es2022"],
    noEmit: true,
  };
}

function strictnessOptions(strictness: Conventions["strictness"]): Record<string, unknown> {
  switch (strictness) {
    case "loose":
      return { strict: false };
    case "strict":
      return { strict: true };
    case "strictest":
      // The options a strict project tends to add once `strict` alone stops catching things.
      return {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
      };
  }
}

/**
 * Module resolution has to agree with the import specifiers the generator emits, or every import in
 * a perfectly good bundle reports "cannot find module" and the mismatch looks like a generation bug.
 */
function moduleOptions(
  moduleStyle: Conventions["moduleStyle"],
  importExtensions: Conventions["importExtensions"],
): Record<string, unknown> {
  if (moduleStyle === "cjs") {
    return importExtensions === "ts"
      ? { module: "commonjs", moduleResolution: "node10", allowImportingTsExtensions: true }
      : { module: "commonjs", moduleResolution: "node10" };
  }

  switch (importExtensions) {
    case "js":
      // `./x.js` specifiers resolving to `./x.ts` sources is the nodenext contract.
      return { module: "nodenext", moduleResolution: "nodenext" };
    case "ts":
      // Importing a `.ts` extension is only legal when nothing is emitted, which holds here.
      return { module: "preserve", moduleResolution: "bundler", allowImportingTsExtensions: true };
    case "none":
      return { module: "preserve", moduleResolution: "bundler" };
  }
}

/**
 * Holds the warm compiler. Create one, keep it, dispose it on shutdown.
 *
 * Concurrent `check` calls are safe, but they are serialised rather than run in parallel. The file
 * tree is swapped in place and the compiler is a single subprocess, so overlapping checks would
 * otherwise verify one caller's bundle against another's files — and interleaved snapshot updates
 * wedge the subprocess outright. Serialising costs nothing real: one compiler cannot check two
 * bundles at once, and a queued check still gets the warm instance (~13ms against ~130ms cold).
 */
export class Typechecker implements Verifier {
  #api: API | undefined;
  readonly #vfs: MutableVerificationFileSystem;
  readonly #timeoutMs: number;
  /** Tail of the queue of checks. Always settled fulfilled, so one failure cannot reject the next. */
  #queue: Promise<void> = Promise.resolve();
  /**
   * Compilers detached by `#abandon` and not yet closed. Held rather than forgotten so that disposal
   * covers them: under a parallel test run the grace period regularly outlives the process itself.
   */
  readonly #abandoned = new Set<API>();

  constructor(options: { readonly timeoutMs?: number } = {}) {
    this.#vfs = createMutableVerificationFileSystem();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Pays the ~130ms cold cost up front, so the first real request does not. */
  async warm(): Promise<void> {
    await this.#exclusive(
      async () =>
        await this.#check([{ path: "index.ts", contents: "export const warm = true;\n" }], {
          strict: true,
        }),
    );
  }

  async check(
    files: readonly BundleFile[],
    conventions: Conventions,
  ): Promise<TypecheckOutcome> {
    const compilerOptions = compilerOptionsFor(conventions);
    const diagnostics = await this.#exclusive(
      async () => await this.#check(files, compilerOptions),
    );
    return { diagnostics, compilerOptions, compilerVersion };
  }

  /**
   * Runs `work` with exclusive use of the file tree and the compiler.
   *
   * The deadline inside `#check` starts only once the turn arrives, so a request that spends time
   * queued is not charged for the wait — otherwise a burst of callers would time out for no reason
   * other than being last in line.
   */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#queue.then(work);
    this.#queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async dispose(): Promise<void> {
    const api = this.#api;
    this.#api = undefined;

    // Abandoned instances too, or a compiler that failed mid-run outlives the disposal that was meant to
    // clean up after it — the case that still left one process behind once the live one was handled.
    const held = [...this.#abandoned, ...(api === undefined ? [] : [api])];
    this.#abandoned.clear();

    await Promise.all(held.map(async (instance) => await release(instance)));
  }

  /**
   * Detach from a compiler that failed us, without closing it immediately.
   *
   * Closing ends the pipe, and a request that is still queued then writes into an ended stream. That
   * throws from inside the vendored JSON-RPC writer where we have nothing to catch it with, so the
   * error arrives as an unhandled rejection — trading a failed check for a dead process. Waiting
   * gives the doomed request time to settle first. If it never does, the subprocess outlives the
   * grace period rather than the host dying, which is the better of the two.
   */
  #abandon(): void {
    const api = this.#api;
    this.#api = undefined;
    if (api === undefined) return;

    this.#abandoned.add(api);

    const timer = setTimeout(() => {
      this.#abandoned.delete(api);
      void release(api);
    }, ABANDON_GRACE_MS);
    timer.unref?.();
  }

  /**
   * Retries once against a fresh compiler. Diagnostics come back as data, so anything *thrown* is
   * infrastructural — a killed subprocess surfaces as "Connection is closed" on the next request,
   * and a replacement recovers in well under 100ms. One retry, not a loop: a fault that survives a
   * restart is a real fault and should surface rather than be absorbed.
   *
   * The timeout is not belt-and-braces. A dead compiler does not reliably reject the request that
   * was in flight, so without a deadline a single crash could hold a request open indefinitely.
   */
  async #check(
    files: readonly BundleFile[],
    compilerOptions: Record<string, unknown>,
  ): Promise<readonly VerificationDiagnostic[]> {
    try {
      return await this.#withDeadline(this.#checkOnce(files, compilerOptions));
    } catch {
      this.#abandon();
      return await this.#withDeadline(this.#checkOnce(files, compilerOptions));
    }
  }

  async #withDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Verification exceeded ${this.#timeoutMs}ms`)),
            this.#timeoutMs,
          );
          // The deadline must not be a reason for the process to stay alive.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #checkOnce(
    files: readonly BundleFile[],
    compilerOptions: Record<string, unknown>,
  ): Promise<readonly VerificationDiagnostic[]> {
    const changes = this.#vfs.replace(treeFor(files, compilerOptions));

    this.#api ??= new API({ fs: this.#vfs.fs, cwd: ROOT });
    const snapshot = await this.#api.updateSnapshot({
      openProjects: [TSCONFIG_PATH],
      fileChanges: changes,
    });


    const project = snapshot.getProjects()[0];
    if (project === undefined) {
      // Only reachable if the tsconfig failed to load, which is our bug rather than the bundle's.
      throw new Error("Verification project failed to open");
    }

    const raw = await project.program.getSemanticDiagnostics();
    return raw.map(toDiagnostic).toSorted(byPathThenCode);
  }
}

/**
 * Ends a compiler and the process behind it.
 *
 * The handle is taken *before* closing, since `close()` drops the reference — read it afterwards and there
 * is nothing left to kill.
 */
async function release(api: API): Promise<void> {
  const child = subprocessOf(api);
  // A crashed compiler makes close() throw; there is nothing left to release, so it does not matter.
  await api.close().catch(() => undefined);
  child?.kill();
}

/**
 * The compiler's subprocess, if the API is still holding one.
 *
 * Reaching past the published surface, which needs justifying. `close()` ends the child's stdin and drops
 * its reference without waiting for it to exit — deliberately, since the child blocks on that read and
 * would deadlock on a signal. What it leaves behind is a live process nobody is waiting for: when the host
 * exits first, the child is reparented to init and stays. Five of them accumulated across a few test runs
 * before this existed, and Vitest reported that something was preventing the run from exiting.
 *
 * So the handle is fetched to do the one thing `close()` does not: end the process. Best-effort by
 * construction — the field is private to an unstable API and may vanish — and if it does, the failure mode
 * is the behaviour we already had rather than a broken verifier.
 *
 * Unreffing it was the other obvious idea and is deliberately not done. It works, in that the host stops
 * being held open, and it also lets the host exit *during* a check: a script that generated one bundle
 * exited mid-verification with the promise unsettled. Trading a hang for a silently dropped verification
 * is not an improvement, so a host that owns a verifier disposes it instead.
 */
function subprocessOf(api: API): Subprocess | undefined {
  const client: unknown = (api as unknown as { readonly client?: unknown }).client;
  if (typeof client !== "object" || client === null) return undefined;

  const child: unknown = (client as { readonly process?: unknown }).process;
  if (typeof child !== "object" || child === null) return undefined;

  const handle = child as { kill?: unknown; unref?: unknown };
  return typeof handle.kill === "function" && typeof handle.unref === "function"
    ? (child as Subprocess)
    : undefined;
}

interface Subprocess {
  kill(): void;
  unref(): void;
}

function treeFor(
  files: readonly BundleFile[],
  compilerOptions: Record<string, unknown>,
): Record<string, string> {
  const tree: Record<string, string> = {
    // Two spaces and a trailing newline: the content is diffed to decide whether the compiler must
    // reload its configuration, so it has to be byte-stable for unchanged options.
    [TSCONFIG_PATH]: `${JSON.stringify({ compilerOptions, include: ["**/*.ts"] }, undefined, 2)}\n`,
  };
  for (const file of files) {
    tree[`${ROOT}/${file.path}`] = file.contents;
  }
  return tree;
}

interface RawDiagnostic {
  readonly code: number;
  readonly text?: string;
  readonly messageText?: string;
  readonly fileName?: string;
}

function toDiagnostic(raw: unknown): VerificationDiagnostic {
  const d = raw as RawDiagnostic;
  return {
    code: d.code,
    // `text` is what this API returns; `messageText` is the classic compiler shape. Accepting both
    // means an upstream rename degrades to a less useful message rather than to `undefined`.
    text: d.text ?? d.messageText ?? "",
    path: d.fileName?.startsWith(`${ROOT}/`) ? d.fileName.slice(ROOT.length + 1) : d.fileName,
  };
}

/** Stable order, so an internal defect reports the same way twice (FR-038). */
function byPathThenCode(a: VerificationDiagnostic, b: VerificationDiagnostic): number {
  const left = a.path ?? "";
  const right = b.path ?? "";
  if (left !== right) return left < right ? -1 : 1;
  return a.code - b.code;
}
