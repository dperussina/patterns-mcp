#!/usr/bin/env node
/**
 * The executable a host launches.
 *
 * Separate from `stdio.ts` so that importing the transport does not start a server. The tests import
 * that module to drive it over injected streams; if it seized this process's stdin on import, the first
 * suite to touch it would hang waiting for frames that never come.
 */

import { disposeEngine } from "../../engine/generate/index.js";
import { disposeOnSignal } from "../../lifecycle.js";
import { stderrLog } from "../log.js";
import { main, runtimeRefusal } from "./stdio.js";

const refusal = runtimeRefusal();

if (refusal === undefined) {
  // Before serving, not after: a host that starts this and immediately changes its mind still sends the
  // signal to a process that knows what to do with it.
  disposeOnSignal(disposeEngine);
  main();
} else {
  // stderr and a non-zero exit, which is all a host reads. Nothing is written to stdout: on this
  // transport stdout is the wire, and a client parsing a diagnostic as a frame would report a protocol
  // error instead of the sentence explaining what is wrong.
  stderrLog(refusal);
  process.exitCode = 1;
}
