/**
 * The MCP server (contracts/mcp-tools.md).
 *
 * An adapter, and nothing more: it translates protocol into engine calls. Generation lives behind
 * `src/index.ts`, which is why a CLI can offer the same capability without sharing a line of this file
 * (Principle X).
 */

import { McpServer } from "@modelcontextprotocol/server";

import { generateInput, generateOutput, handleGenerate } from "./tools/generate.js";

/**
 * Read-only, non-destructive, idempotent, closed-world — all four true of every tool here, because
 * generation writes nothing and consults nothing outside the request.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Generation is cacheable keyed on the whole input, which is a consequence of determinism rather than
 * an optimisation: the same request cannot produce a different bundle, so a cached response cannot be
 * stale (Principle I).
 */
const CACHEABLE = { "io.modelcontextprotocol/cache-hint": { cacheable: true, scope: "public" } };

export function createServer(): McpServer {
  const server = new McpServer({ name: "patterns", version: "0.1.0" });

  server.registerTool(
    "generate_pattern",
    {
      title: "Generate a pattern implementation",
      description:
        "Generate a complete, reusable TypeScript module implementing a known pattern, fitted to your " +
        "project's conventions. Every bundle is typechecked before it is returned, and its tests are " +
        "executed, so what you receive compiles and passes. Identical requests return identical bytes.",
      inputSchema: generateInput,
      outputSchema: generateOutput,
      annotations: READ_ONLY,
      _meta: CACHEABLE,
    },
    async (args) => await handleGenerate(args),
  );

  return server;
}
