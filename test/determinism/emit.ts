/**
 * Generates one bundle and writes it to stdout as canonical JSON.
 *
 * A separate entry point rather than an inline function, because the point of the byte-equality
 * harness is to compare across *process restarts*: a same-process comparison would pass even if
 * output depended on a module-level cache, a warmed compiler, or anything else that survives between
 * calls but not between runs.
 *
 * Takes the request as a single JSON argument so the harness can vary it without a second file.
 */

import { disposeEngine, generate } from "../../src/engine/generate/index.js";

const request: unknown = JSON.parse(process.argv[2] ?? "{}");

const result = await generate(request as Parameters<typeof generate>[0]);

// Files only, plus the content hash. Deliberately not the compiler version: that legitimately differs
// between toolchains and is not part of what must be byte-identical.
process.stdout.write(
  `${JSON.stringify({
    files: result.files.map((file) => [file.role, file.path, file.contents]),
    contentHash: result.verification.contentHash,
    resolvedOptions: result.resolvedOptions,
  })}\n`,
);

await disposeEngine();
