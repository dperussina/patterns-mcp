/**
 * Verifying a binding against a core the caller already has (research.md §11, T104).
 *
 * A `binding-only` bundle is a fragment. It imports the machinery from `coreModule` — a path in the
 * caller's repository that this process has never seen — so on its own it cannot be typechecked at all:
 * every reference to `Repository`, `Store`, or `CollectionSpec` is an unresolved module.
 *
 * Principle III has no exception for fragments, so the core is *regenerated* into the verification file
 * system at the place the binding looks for it, the binding is checked and its tests run against it, and
 * it is then discarded rather than emitted. What the caller receives is the binding alone; what was
 * proven is that the binding compiles and works against the core this pattern produces.
 *
 * The honest limit is worth stating plainly, because it is the one thing this cannot establish: the core
 * regenerated here is the one *this request's options* describe, not the file actually sitting in the
 * caller's repository. If they installed the core with `pagination: "offset"` and ask for a binding with
 * `pagination: "cursor"`, both halves are internally consistent and the pair will not fit — and nothing
 * here can see their file to say so. That is what the emitted note is for (T105): it names the options
 * the core must have been generated with, so the mismatch is a glance at their own provenance header
 * rather than a compiler error in a file they did not generate.
 *
 * Nothing is rewritten to make this work. The specifier in the verified bytes is the specifier in the
 * emitted bytes, which is what keeps "the code that was checked is the code you received" true for a
 * fragment as well as for a whole bundle. Making a bare specifier resolve instead of repointing it costs
 * one `package.json`, and repointing would have cost the invariant.
 *
 * Two placements, because a module specifier has two kinds:
 *
 * **Relative — `./lib/repository-core.js`.** The core is written at the path that specifier resolves to.
 * Nothing clever: the file simply is where the binding looks for it.
 *
 * **Bare — `@acme/data`.** Written as a package under `node_modules`, which is the same device the test
 * runner shim already uses to make `import … from "vitest"` resolve inside a sandbox with no
 * dependencies. An ambient `declare module` was the first attempt and cannot work: TypeScript refuses to
 * let one re-export through a relative path (TS2439), so the declaration would have to restate the
 * core's whole surface — a second copy, free to disagree with the first, which is how verification comes
 * to pass because the declaration was wrong rather than because the code was right.
 */

import type { RenderedFile } from "../patterns/types.js";

export interface SynthesisInput {
  /** Everything the pattern rendered, including the core this scope will not emit. */
  readonly files: readonly RenderedFile[];
  /** The caller's specifier, already checked by `checkCoreModule`. */
  readonly coreModule: string;
}

export interface Synthesis {
  /** The rendered files, with the core moved to where the binding's import resolves. */
  readonly files: readonly RenderedFile[];
  /**
   * Files written exactly as given, to both the compiler's file system and the test sandbox — a
   * `package.json` is neither TypeScript nor something to transpile. Kept apart from `files` so that
   * nothing downstream can emit them by accident: not being returned is the whole point.
   */
  readonly verbatim: readonly { readonly path: string; readonly contents: string }[];
}

/**
 * The file set to verify for a binding-only request.
 *
 * A pattern that rendered no core is a defect rather than a caller error: its catalog entry said it
 * splits, and a split with nothing on one side of it is not one.
 */
export function synthesizeCore(input: SynthesisInput): Synthesis {
  const core = input.files.filter((file) => file.role === "core" || file.role === "types");
  const primary = core[0];

  if (primary === undefined) {
    throw new Error(
      "binding-only verification needs a core to check the binding against, and the pattern " +
        "rendered none. A pattern declaring supportsSplit must render at least one core file.",
    );
  }

  if (core.length > 1) {
    // One specifier cannot name two modules. A pattern that splits its machinery across several files
    // has to be told which one `coreModule` refers to, and there is no way to ask.
    throw new Error(
      `binding-only verification cannot place ${String(core.length)} core files behind one ` +
        `coreModule specifier. A pattern that splits must render its machinery as a single module.`,
    );
  }

  const target = isRelative(input.coreModule)
    ? relativeTarget(input.coreModule)
    : `node_modules/${input.coreModule}/index.ts`;

  return {
    files: input.files.map((file) =>
      file.path === primary.path ? { ...file, path: target } : file,
    ),
    verbatim: isRelative(input.coreModule)
      ? []
      : [
          {
            path: `node_modules/${input.coreModule}/package.json`,
            contents: `${JSON.stringify(
              {
                name: input.coreModule,
                // `types` for the compiler, `main` for the sandbox, which runs the transpiled copy.
                types: "index.ts",
                main: "index.js",
              },
              undefined,
              2,
            )}\n`,
          },
        ],
  };
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * The file path a relative specifier resolves to.
 *
 * `../` cannot appear: `checkCoreModule` refuses a `..` segment, because verification that reached
 * outside its own root would be checking against something the caller's project need not contain
 * either — and `assertSafePath` in the test sandbox refuses it a second time.
 */
function relativeTarget(specifier: string): string {
  return `${specifier.slice(2).replace(/\.[cm]?[jt]sx?$/, "")}.ts`;
}
