/**
 * Virtual file system for the verification gate.
 *
 * The TypeScript API's `FileSystem.readFile` is tri-state, and the three states are not
 * interchangeable:
 *
 * - a `string` is the file's content (`""` is a legitimate empty file, not a miss)
 * - `null` means "this file does not exist" and stops there
 * - `undefined` means "I have no opinion" and falls back to the real filesystem
 *
 * Lib files (`lib.es2022.d.ts` and friends) are not ours to supply. Under TypeScript 7 they ship
 * inside a platform binary package rather than `node_modules/typescript/lib`, so hard-coding their
 * location would break on every other platform. They must return `undefined` and resolve from disk.
 * Returning `null` for them instead blocks lib resolution and the compiler reports every global as
 * missing — a screen of "Cannot find name 'Promise'" that looks like a bug in the generated bundle
 * rather than a bug in the host.
 *
 * Everything that is neither ours nor a lib file returns `null`. That is the deliberate difference
 * from `createVirtualFileSystem` in `typescript/unstable/fs`, which returns `undefined` for every
 * unknown path. The measured consequence is not exotic: point the built-in helper at a directory
 * containing a real `tsconfig.json` that is absent from the virtual map, and it opens that config
 * off disk, so verification silently runs under whatever `strict` and `target` happen to be sitting
 * there instead of the options we pinned. Ours declines to open a project at all, which is the
 * failure we want — loud, and not a bundle certified under settings we never chose.
 *
 * The hermetic boundary is `readFile`, because content is the thing worth protecting. The existence
 * and directory-listing callbacks defer to disk outside our tree, since answering "no" for the
 * directory holding the lib files breaks resolution just as thoroughly as answering `null` for the
 * files themselves.
 *
 * `readThrough` is a seam as much as a safety valve: verifying a binding-only bundle means resolving
 * types for a package we did not emit, which needs a wider read-through set than lib files alone.
 */

import type { FileSystem, FileSystemEntries } from "typescript/unstable/fs";
import type { FileChangeSummary } from "typescript/unstable/proto";

/** Matches `lib.d.ts`, `lib.es2022.d.ts`, `lib.dom.iterable.d.ts`, and the rest of the family. */
const LIB_FILE = /^lib\.[a-z0-9.]*d\.ts$/;

export interface VerificationFileSystemOptions {
  /** Absolute path to content mapping. Paths must be POSIX-style and absolute. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Paths permitted to fall through to the real filesystem. Defaults to lib files only. Widening
   * this weakens the hermetic guarantee, so callers should pass the narrowest predicate that works.
   */
  readonly readThrough?: (path: string) => boolean;
}

/** True when the path names a TypeScript lib declaration file, wherever it happens to live. */
export function isLibPath(path: string): boolean {
  return LIB_FILE.test(basename(path));
}

/**
 * A file system whose contents can be swapped between checks, so one warmed compiler instance can
 * serve many bundles. Cold checks cost ~130ms against ~13ms warm, so reuse is the difference between
 * verification being affordable on every request and not.
 *
 * `replace` returns the change summary rather than leaving the caller to describe what it did. That
 * is deliberate: the compiler serves a cached result when it is not told what changed, so a caller
 * who swapped the files but forgot to report it receives a verdict about the *previous* bundle.
 * Measured, not theorised — a broken bundle came back with zero diagnostics that way. Deriving the
 * summary from the same map the compiler reads removes the chance to get it wrong.
 */
export interface MutableVerificationFileSystem {
  readonly fs: FileSystem;
  /** Swap the whole tree, returning the summary to hand to `updateSnapshot`. */
  replace(files: Readonly<Record<string, string>>): FileChangeSummary;
}

interface Tree {
  files: Map<string, string>;
  directories: ReadonlySet<string>;
}

export function createVerificationFileSystem(options: VerificationFileSystemOptions): FileSystem {
  const files = new Map(Object.entries(options.files));
  return fileSystemOver(
    { files, directories: collectDirectories(files.keys()) },
    options.readThrough ?? isLibPath,
  );
}

export function createMutableVerificationFileSystem(
  options: Omit<VerificationFileSystemOptions, "files"> & {
    readonly files?: Readonly<Record<string, string>>;
  } = {},
): MutableVerificationFileSystem {
  const initial = new Map(Object.entries(options.files ?? {}));
  const tree: Tree = { files: initial, directories: collectDirectories(initial.keys()) };

  return {
    fs: fileSystemOver(tree, options.readThrough ?? isLibPath),
    replace(files) {
      const next = new Map(Object.entries(files));
      const summary = diff(tree.files, next);
      tree.files = next;
      tree.directories = collectDirectories(next.keys());
      return summary;
    },
  };
}

/**
 * Sorted so the request is byte-identical for identical work, and so a failure is reproducible
 * rather than dependent on map iteration order.
 */
function diff(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): FileChangeSummary {
  const created: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];

  for (const [path, contents] of after) {
    const previous = before.get(path);
    if (previous === undefined) created.push(path);
    else if (previous !== contents) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path);
  }

  return {
    created: created.toSorted(compare),
    changed: changed.toSorted(compare),
    deleted: deleted.toSorted(compare),
  };
}

function fileSystemOver(tree: Tree, readThrough: (path: string) => boolean): FileSystem {
  const owns = (path: string): boolean => tree.files.has(path) || tree.directories.has(path);

  return {
    readFile(fileName) {
      const content = tree.files.get(fileName);
      if (content !== undefined) return content;
      if (readThrough(fileName)) return undefined;
      return null;
    },

    fileExists(fileName) {
      if (tree.files.has(fileName)) return true;
      if (readThrough(fileName)) return undefined;
      return false;
    },

    directoryExists(directoryName) {
      if (tree.directories.has(directoryName)) return true;
      // No opinion. Claiming a real directory is absent would break lib resolution.
      return undefined;
    },

    getAccessibleEntries(directoryName) {
      if (!tree.directories.has(directoryName)) return undefined;
      return entriesOf(directoryName, tree.files.keys(), tree.directories);
    },

    realpath(path) {
      // Identity inside our tree: virtual paths have no symlinks to resolve, and resolving them
      // against the real filesystem could rewrite a virtual path into something unrecognisable.
      return owns(path) ? path : undefined;
    },
  };
}

function entriesOf(
  directory: string,
  paths: Iterable<string>,
  directories: ReadonlySet<string>,
): FileSystemEntries {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  const files: string[] = [];
  for (const path of paths) {
    if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
      files.push(path.slice(prefix.length));
    }
  }

  const children: string[] = [];
  for (const candidate of directories) {
    if (candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/")) {
      children.push(candidate.slice(prefix.length));
    }
  }

  // Sorted so a directory listing cannot make a verification result depend on insertion order.
  return { files: files.toSorted(compare), directories: children.toSorted(compare) };
}

/** Every ancestor directory of every file, so `directoryExists` can answer for our own tree. */
function collectDirectories(paths: Iterable<string>): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    let current = dirname(path);
    while (current !== "" && current !== "/" && !directories.has(current)) {
      directories.add(current);
      current = dirname(current);
    }
    if (current === "/") directories.add("/");
  }
  return directories;
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index === -1) return "";
  if (index === 0) return "/";
  return path.slice(0, index);
}

/** Code-unit comparison, matching the ordering used everywhere else in the engine. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
