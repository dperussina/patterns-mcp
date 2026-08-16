#!/usr/bin/env node
/**
 * The executable a host launches.
 *
 * Separate from `stdio.ts` so that importing the transport does not start a server. The tests import
 * that module to drive it over injected streams; if it seized this process's stdin on import, the first
 * suite to touch it would hang waiting for frames that never come.
 */

import { stderrLog } from "../log.js";
import { main, runtimeRefusal } from "./stdio.js";

const refusal = runtimeRefusal();

if (refusal === undefined) {
  main();
} else {
  // stderr and a non-zero exit, which is all a host reads. Nothing is written to stdout: on this
  // transport stdout is the wire, and a client parsing a diagnostic as a frame would report a protocol
  // error instead of the sentence explaining what is wrong.
  stderrLog(refusal);
  process.exitCode = 1;
}
