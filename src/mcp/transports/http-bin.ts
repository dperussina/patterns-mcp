#!/usr/bin/env node
/**
 * The executable an operator runs to serve the protocol over the network (FR-030).
 *
 * A second binary rather than a flag on `patterns-mcp`, because the two entries answer to different people.
 * A client spawns the stdio one and never types its name; an operator runs this one, chooses a port, and has
 * to decide which hostnames may reach it. Keeping them apart also keeps the stdio entry's one hard rule —
 * stdout is the wire, so nothing but frames may be written there — confined to the file where it is true.
 *
 * Separate from `http.ts` for the reason `stdio-bin.ts` is separate from `stdio.ts`: importing a transport to
 * test it must not bind a port, or the first suite to touch the module would hold one for the whole run.
 */

import { disposeEngine } from "../../engine/generate/index.js";
import { disposeOnSignal } from "../../lifecycle.js";
import { stderrLog } from "../log.js";
import { main } from "./http.js";

/**
 * Wrapped rather than written as top-level `await`, which the bundler cannot express in every output format
 * it emits — the same reason the `patterns` binary next door has one of these.
 */
async function start(): Promise<void> {
  // A serving process is ended by a signal rather than by running out of work, so this is the only exit
  // path that matters here — without it, stopping the server strands the compiler it warmed.
  disposeOnSignal(disposeEngine);

  const code = await main();

  // Only when it declined to start. A serving process is meant to stay up, and disposing the compiler out
  // from under it would make the first generation pay to start a new one.
  if (code !== 0) {
    await disposeEngine();
    process.exitCode = code;
  }
}

start().catch((error: unknown) => {
  stderrLog(`patterns-mcp-http failed before it could serve. This is a defect in the tool.\n${String(error)}`);
  process.exitCode = 70;
});
