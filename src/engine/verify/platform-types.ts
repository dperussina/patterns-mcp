/**
 * Declarations for the runtime facilities every JavaScript host provides.
 *
 * Verification compiles with `lib: ["es2022"]` and no package types, which is what makes it hermetic —
 * a bundle is proven against the language, not against whatever happens to be installed here. But
 * `setTimeout` and `AbortSignal` are not language features and not packages either: they are part of
 * every host the generated code can run in — Node, browsers, Deno, workers — and are declared by
 * `@types/node` or by `lib.dom` in a real project. Without them the sandbox rejects any pattern that
 * waits or that can be cancelled, which is the entire async-resilience category.
 *
 * The declarations are deliberately the portable intersection rather than any one host's version. A
 * timer handle is opaque, because Node returns an object and browsers return a number, and generated
 * code that treated it as either would compile here and fail in half of the projects that adopt it.
 *
 * Skipped for `runtime: "browser"`, where `lib.dom` already declares all of this and a second
 * declaration would collide.
 */

import type { Conventions } from "../options/conventions.js";

/**
 * `PlatformTimer` is opaque on purpose: a handle is only ever passed back to `clearTimeout`. Naming it
 * rather than using `unknown` keeps that legible in generated signatures, and inference means the same
 * code still compiles in a project where the handle is a `Timeout` or a `number`.
 */
const PLATFORM_GLOBALS = `interface PlatformTimer {
  readonly __platformTimer?: never;
}

declare function setTimeout(handler: () => void, timeoutMs?: number): PlatformTimer;
declare function clearTimeout(handle: PlatformTimer | undefined): void;
declare function setInterval(handler: () => void, intervalMs?: number): PlatformTimer;
declare function clearInterval(handle: PlatformTimer | undefined): void;
declare function queueMicrotask(callback: () => void): void;

interface AbortSignal {
  readonly aborted: boolean;
  /** Why the signal was aborted. Typed \`unknown\` because a host may put anything here. */
  readonly reason: unknown;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
  /** Throws \`reason\` when aborted, and does nothing otherwise. */
  throwIfAborted(): void;
}

declare const AbortSignal: {
  readonly prototype: AbortSignal;
  abort(reason?: unknown): AbortSignal;
  timeout(milliseconds: number): AbortSignal;
};

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare const AbortController: {
  readonly prototype: AbortController;
  new (): AbortController;
};

interface Console {
  log(...data: readonly unknown[]): void;
  info(...data: readonly unknown[]): void;
  warn(...data: readonly unknown[]): void;
  error(...data: readonly unknown[]): void;
}

declare const console: Console;
`;

/**
 * Ambient declarations to compile alongside a bundle, keyed by file name.
 *
 * A map rather than a string so this composes with `shimTypesFor` at the call site, and so adding a
 * second file later does not change the shape callers depend on.
 */
export function platformTypesFor(conventions: Conventions): ReadonlyMap<string, string> {
  if (conventions.runtime === "browser") return new Map();
  return new Map([["platform-globals.d.ts", PLATFORM_GLOBALS]]);
}
