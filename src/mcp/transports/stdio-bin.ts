#!/usr/bin/env node
/**
 * The executable a host launches.
 *
 * Separate from `stdio.ts` so that importing the transport does not start a server. The tests import
 * that module to drive it over injected streams; if it seized this process's stdin on import, the first
 * suite to touch it would hang waiting for frames that never come.
 */

import { main } from "./stdio.js";

main();
