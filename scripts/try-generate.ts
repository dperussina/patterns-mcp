/**
 * Scratch driver: generate one bundle and print it. Not part of `check`.
 *
 * `pnpm exec tsx scripts/try-generate.ts repository '{"emitScope":"core-only"}'`
 */
import { disposeEngine, generate } from "../src/engine/generate/index.js";

const options = JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>;

try {
  const bundle = await generate({
    pattern: process.argv[2] ?? "repository",
    identifiers: { entity: "Order" },
    options,
  });

  for (const file of bundle.files) {
    process.stdout.write(`\n${"=".repeat(90)}\n${file.path}  [${file.role}]\n${"=".repeat(90)}\n`);
    process.stdout.write(file.contents);
  }

  if (bundle.notes.length > 0) {
    process.stdout.write(`\nNOTES\n${bundle.notes.map((n) => `- ${n}`).join("\n")}\n`);
  }
  process.stdout.write(`\n${JSON.stringify(bundle.verification, null, 2)}\n`);
} finally {
  // Without this the warm compiler subprocess keeps this process alive after the output is written,
  // which reads as a hang and leaves an orphaned `tsc --api` behind when it is killed (T028).
  await disposeEngine();
}
