/**
 * `generate()` narrowed to the bundle case, for the suites that only ever ask for generative patterns.
 *
 * The engine answers a generate request with a bundle or with advisory guidance (FR-022), and a caller
 * that does not know which kind it asked for has to discriminate — that union is the point, and the MCP
 * and CLI adapters both handle it. These suites are not that caller: each one names a generative pattern
 * from the catalogue and would have no idea what to do with advice. Threading a `kind` check through
 * every one of them would add a branch that cannot be taken to about forty call sites, and a branch no
 * test can reach is worse than no branch — it reads as though the case were handled.
 *
 * So the narrowing happens once, here, and it throws rather than asserting: if a suite ever does receive
 * advice, that means the catalogue entry it names changed kind underneath it, and the failure should say
 * so in one line instead of surfacing as `undefined` where files were expected.
 */

import { generate } from "../src/engine/generate/index.js";

import type { Bundle, GenerateRequest } from "../src/engine/generate/index.js";

export async function generateBundle(request: GenerateRequest): Promise<Bundle> {
  const result = await generate(request);

  if (result.kind !== "bundle") {
    throw new Error(
      `expected a bundle from "${request.pattern}", got advice to use ${result.alternative}. ` +
        `The catalogue entry is advisory, so this suite is naming the wrong pattern.`,
    );
  }

  return result;
}
