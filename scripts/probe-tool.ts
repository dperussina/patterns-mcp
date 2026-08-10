/**
 * Scratch driver: call one tool over the in-memory transport and print what came back. Not part of
 * `check`. Useful where `try-generate.ts` is not, since it exercises schema validation and the error
 * mapping a caller actually sees.
 *
 * `pnpm exec tsx scripts/probe-tool.ts generate_pattern '{"pattern":"result","identifiers":{"entity":"Order"}}'`
 */
import { connect } from "../test/contract/client.js";

const session = await connect();
try {
  const result = await session.client.callTool({
    name: process.argv[2] ?? "generate_pattern",
    arguments: JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>,
  });
  process.stdout.write(`isError=${String(result.isError)}\n`);
  process.stdout.write(`${JSON.stringify(result.content, undefined, 2).slice(0, 3000)}\n`);
} finally {
  await session.close();
}
