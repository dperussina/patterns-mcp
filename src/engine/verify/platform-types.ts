/**
 * Declarations for the runtime facilities every JavaScript host provides.
 *
 * Verification compiles with `lib: ["es2022"]` and no package types, which is what makes it hermetic —
 * a bundle is proven against the language, not against whatever happens to be installed here. But
 * `setTimeout` and `AbortSignal` are not language features and not packages either: they are part of
 * every host the generated code can run in — Node, browsers, Deno, workers — and are declared by
 * `@types/node` or by `lib.dom` in a real project. Without them the sandbox rejects any pattern that
 * waits or that can be cancelled, which is the entire async-resilience category, and any pattern that
 * speaks HTTP, which is every gateway.
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
 * `fetch` and the types around it, for patterns that reach a remote service.
 *
 * Universal in the same sense as the timers above — Node has had `fetch` since 18, and browsers,
 * Deno, Bun, and workers all have it — and undeclared here for the same reason, since it comes from
 * `@types/node` or `lib.dom` in a real project rather than from the language.
 *
 * Two departures from the real declarations, both deliberate and both in the strict direction.
 *
 * `json()` returns `unknown` where `lib.dom` returns `any`. That is stricter than reality, which is the
 * only safe direction to be wrong in: a bundle that narrows an `unknown` body compiles here *and* in a
 * project whose `json()` returns `any`, whereas a bundle that read a field straight off `any` would
 * compile here and be exactly the unvalidated boundary that a generated gateway exists to prevent.
 *
 * `Request` is absent, along with `Blob` and `FormData`. Nothing generated constructs one — a transport
 * passes a URL and an init object — and the doctrine this file was written under is to grow one entry at
 * a time rather than to mirror a host's whole surface. `Headers` appears only in its readable form for
 * the same reason: responses are read, request headers are a plain record.
 *
 * The response body's stream *is* here, because a pattern that reads a server-sent event stream cannot
 * be written without it. It is declared in the least a reader needs and without a type parameter:
 * `ReadableStream<Uint8Array>` is what the real `body` is, but a bundle that named the generic form
 * would be naming a type it has no other use for, and one that names its own structural minimum accepts
 * this declaration and a real `body` alike. `TextDecoder` is here on the same footing as `fetch` — a
 * platform global since Node 11, and in every browser, Deno, and Bun — and for the same reason: turning
 * bytes into text is not something a generated bundle can do for itself.
 */
const PLATFORM_HTTP = `interface Headers {
  get(name: string): string | null;
  has(name: string): boolean;
  forEach(callback: (value: string, name: string) => void): void;
}

interface ReadableStreamDefaultReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  releaseLock(): void;
}

interface ReadableStream {
  getReader(): ReadableStreamDefaultReader;
}

interface TextDecoder {
  decode(input?: Uint8Array, options?: { readonly stream?: boolean }): string;
}

declare const TextDecoder: {
  readonly prototype: TextDecoder;
  new (label?: string): TextDecoder;
};

interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
  readonly body: ReadableStream | null;
  /** \`unknown\`, not \`any\`: a response body is untrusted until something checks it. */
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface RequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

declare function fetch(url: string | URL, init?: RequestInit): Promise<Response>;

interface URLSearchParams {
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  append(name: string, value: string): void;
  toString(): string;
}

interface URL {
  readonly searchParams: URLSearchParams;
  href: string;
  pathname: string;
  toString(): string;
}

declare const URL: {
  readonly prototype: URL;
  new (url: string, base?: string | URL): URL;
};
`;

/**
 * Ambient declarations to compile alongside a bundle, keyed by file name.
 *
 * A map rather than a string so this composes with `shimTypesFor` at the call site, and so adding a
 * second file later does not change the shape callers depend on.
 *
 * Every file is supplied to every bundle rather than only to the patterns that need one. Emitting them
 * conditionally would make what compiles depend on which pattern was asked for, so a template that
 * reached for `fetch` without saying so would verify in one request and not another — and an unused
 * ambient declaration costs a bundle nothing.
 */
export function platformTypesFor(conventions: Conventions): ReadonlyMap<string, string> {
  if (conventions.runtime === "browser") return new Map();
  return new Map([
    ["platform-globals.d.ts", PLATFORM_GLOBALS],
    ["platform-http.d.ts", PLATFORM_HTTP],
  ]);
}
