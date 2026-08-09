/**
 * The stdio entry point (plan.md §Source layout).
 *
 * On this transport stdout is not an output stream, it is the wire. Anything written to it that is not
 * a JSON-RPC frame corrupts the message stream, and the symptom — a client parse error, arbitrarily far
 * from the write that caused it — is among the least debuggable failures this server could have. So
 * every diagnostic goes to stderr, and `console` is rerouted there before the connection opens rather
 * than trusted not to be called: the risk is not our own `console.log` but a dependency's.
 *
 * Two entry shapes, because they answer different needs. `serveStdioOn` takes its transport and its log
 * sink as arguments and is what the contract tests drive. `main` is what a host runs: it owns the
 * process, so it is the only one of the two allowed to touch global state.
 */

import type { Transport } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { stderrLog } from "../log.js";
import type { Logger } from "../log.js";
import { createServer } from "../server.js";

export interface ServeStdioOn {
  /** Defaults to this process's stdin and stdout. */
  readonly transport?: Transport;
  /** Where out-of-band errors go. Defaults to stderr. */
  readonly log?: Logger;
}

/**
 * Serves the protocol over `transport`, reporting out-of-band errors to `log`.
 *
 * The server is passed as a factory because the SDK pins one instance per connection once the opening
 * exchange has settled which protocol era is in play. Constructing it eagerly and handing over the
 * instance would take that decision away from the SDK.
 */
export function serveStdioOn(options: ServeStdioOn = {}): StdioServerHandle {
  const log = options.log ?? stderrLog;

  return serveStdio(() => createServer(), {
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    onerror: (error: Error) => {
      log(`error: ${error.message}`);
    },
  });
}

/**
 * Points every `console` method at stderr.
 *
 * `console.error` and `console.warn` already write there; `log`, `info`, `debug`, and `trace` do not,
 * and those are the ones a stray call is most likely to use. Returns a function that puts the original
 * methods back, so a test can assert this happened without leaking the change into other suites.
 */
export function routeConsoleToStderr(): () => void {
  const diverted = ["log", "info", "debug", "trace", "dir"] as const;
  const original = new Map(diverted.map((name) => [name, console[name]] as const));

  for (const name of diverted) {
    console[name] = (...args: readonly unknown[]): void => {
      stderrLog(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
  }

  return () => {
    for (const [name, method] of original) console[name] = method;
  };
}

/**
 * Runs the server over this process's stdio until stdin closes.
 *
 * Deliberately does not install signal handlers. A host that wants this process gone sends a signal and
 * the default disposition ends it; a handler that awaited an orderly close would delay that, and there
 * is nothing to flush — no state is written anywhere, so an abrupt end loses nothing.
 */
export function main(): StdioServerHandle {
  routeConsoleToStderr();
  return serveStdioOn({ transport: new StdioServerTransport() });
}
