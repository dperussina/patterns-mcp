/**
 * The stable verification path.
 *
 * The primary path uses an API that is explicitly labelled unstable, and the constitution permits
 * that only while a stable path stands behind it. This is that path: the classic
 * `createProgram` API from a separately pinned `typescript@6.0.3`, aliased as `typescript-stable` so
 * both compilers can coexist with the 7.x one the project builds with.
 *
 * It is slower and it is meant to be. Its job is to keep the verification gate available on the day
 * the unstable API breaks, because Principle III admits no version of this service that returns
 * unverified code.
 *
 * Two differences from the primary path are worth knowing rather than discovering:
 *
 * - Options arrive here in JSON form (`"nodenext"`, `["es2022"]`) and the classic API wants enums, so
 *   they go through `convertCompilerOptionsFromJson`. Passing the JSON form straight in silently
 *   yields a program with no module resolution at all.
 * - There is no warm instance to keep. `createProgram` builds a fresh program per check, which is
 *   the bulk of why this path costs more.
 */

import ts from "typescript-stable";

import type { Conventions } from "../options/conventions.js";
import { compilerOptionsFor } from "./typecheck.js";
import type { BundleFile, TypecheckOutcome, VerificationDiagnostic, Verifier } from "./typecheck.js";

const ROOT = "/verify";

export const fallbackCompilerVersion: string = ts.version;

export class FallbackTypechecker implements Verifier {
  /** Nothing to warm: each check builds its own program. Present so the two paths interchange. */
  async warm(): Promise<void> {
    // Intentionally empty.
  }

  async dispose(): Promise<void> {
    // Nothing is held.
  }

  async check(
    files: readonly BundleFile[],
    conventions: Conventions,
  ): Promise<TypecheckOutcome> {
    const compilerOptions = compilerOptionsFor(conventions);
    const converted = ts.convertCompilerOptionsFromJson(compilerOptions, ROOT);
    if (converted.errors.length > 0) {
      // Our own option mapping is wrong, not the caller's bundle.
      throw new Error(
        `Verification options rejected by the stable compiler: ${converted.errors
          .map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "))
          .join("; ")}`,
      );
    }

    const sources = new Map(files.map((file) => [`${ROOT}/${file.path}`, file.contents]));
    const program = ts.createProgram({
      rootNames: [...sources.keys()].toSorted(compare),
      options: converted.options,
      host: hostFor(sources, converted.options),
    });

    return {
      diagnostics: program
        .getSemanticDiagnostics()
        .map(toDiagnostic)
        .toSorted(byPathThenCode),
      compilerOptions,
      compilerVersion: ts.version,
    };
  }
}

/**
 * A compiler host over the in-memory bundle, falling through to disk for lib files only — the same
 * boundary the primary path draws, reached through a different interface. Lib files come from the
 * stable compiler's own `lib` directory, which is where `getDefaultLibFilePath` points.
 */
function hostFor(
  sources: ReadonlyMap<string, string>,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const readThrough = (fileName: string): boolean => isLibFile(fileName);
  const real = ts.sys;
  const libDirectory = dirname(ts.getDefaultLibFilePath(options));

  // Directory questions are how module resolution walks for node_modules, so answering them from the
  // real filesystem would let a bare specifier resolve against whatever is installed beside this
  // server. Only the bundle's own root and the compiler's lib directory exist as far as the host is
  // concerned. Without this the boundary would rest on ROOT happening not to exist on disk.
  const visibleDirectory = (directoryName: string): boolean =>
    directoryName === ROOT || directoryName === libDirectory;

  return {
    getSourceFile(fileName, languageVersionOrOptions) {
      const contents = sources.get(fileName) ?? (readThrough(fileName) ? real.readFile(fileName) : undefined);
      if (contents === undefined) return undefined;
      return ts.createSourceFile(fileName, contents, languageVersionOrOptions, true);
    },
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    writeFile() {
      // noEmit is pinned on, so nothing should ever ask. Silently dropping a write is still safer
      // than letting verification touch a real filesystem.
    },
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => sources.has(fileName) || (readThrough(fileName) && real.fileExists(fileName)),
    readFile: (fileName) =>
      sources.get(fileName) ?? (readThrough(fileName) ? real.readFile(fileName) : undefined),
    directoryExists: (directoryName) => visibleDirectory(directoryName),
    getDirectories: (directoryName) =>
      directoryName === libDirectory ? real.getDirectories(directoryName) : [],
    realpath: (fileName) => fileName,
    getDefaultLibLocation: () => libDirectory,
  };
}

/** Same family as the primary path's check, against the same filename shapes. */
function isLibFile(fileName: string): boolean {
  return /^lib\.[a-z0-9.]*d\.ts$/.test(basename(fileName));
}

function toDiagnostic(diagnostic: ts.Diagnostic): VerificationDiagnostic {
  const fileName = diagnostic.file?.fileName;
  return {
    code: diagnostic.code,
    text: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    path: fileName?.startsWith(`${ROOT}/`) ? fileName.slice(ROOT.length + 1) : fileName,
  };
}

function byPathThenCode(a: VerificationDiagnostic, b: VerificationDiagnostic): number {
  const left = a.path ?? "";
  const right = b.path ?? "";
  if (left !== right) return left < right ? -1 : 1;
  return a.code - b.code;
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
