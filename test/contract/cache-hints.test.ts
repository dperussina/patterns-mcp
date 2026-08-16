/**
 * Every result says what may be done with it (FR-042).
 *
 * The requirement is not "be cacheable", it is "say so explicitly rather than defaulting to the most
 * conservative available value" — and the SDK's fallback is `ttlMs: 0, cacheScope: 'private'`, which
 * describes a server whose answers depend on who asked and change between calls. Neither is true here:
 * the catalogue ships with the build and generation is deterministic. Silence would therefore not be a
 * cautious approximation but a false one, paid for by an agent re-fetching the same catalogue through
 * every step of a task.
 *
 * Two vehicles carry it, for the reason set out in `src/mcp/cache.ts`: the protocol's own fields on the
 * closed list of cacheable results, and `_meta` on `tools/call`, which is permanently off that list. This
 * file is about the second, and about the declaration behind the first; `revision.test.ts` reads the
 * protocol fields off the wire on a session that speaks the revision defining them.
 *
 * That division is a repair. These assertions were once gated on the SDK's `SUPPORTED_PROTOCOL_VERSIONS`,
 * which lists the *legacy* revisions and so will never contain `2026-07-28` — the gate could not open, the
 * wire was never read, and the case that ran in its place asserted that the fields could not possibly work.
 * They had been working the whole time. A test that is skipped by a condition that can never come true is
 * indistinguishable from one that passes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CACHE_TTL_MS, PROTOCOL_CACHE_HINTS } from "../../src/mcp/cache.js";
import { CACHE_HINT_META_KEY, CORRECTABLE_META_KEY, ERROR_CODE_META_KEY } from "../../src/mcp/meta.js";
import { connect } from "./client.js";
import type { Session } from "./client.js";

/**
 * The operations whose results the revision makes cacheable. Closed: `tools/call` is not among them and
 * is not an omission, which is why the tools carry `_meta` instead.
 */
const CACHEABLE_METHODS = [
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "server/discover",
] as const;

let session: Session;

beforeAll(async () => {
  session = await connect();
});

afterAll(async () => {
  await session.close();
});

interface Hint {
  readonly ttlMs?: number;
  readonly cacheScope?: string;
}

function hintOn(meta: unknown, where: string): Hint {
  const hint = (meta as Record<string, unknown> | undefined)?.[CACHE_HINT_META_KEY];
  expect(hint, `${where} states nothing about cacheability, so a client must assume the worst`).toBeDefined();
  return hint as Hint;
}

/** The one shape worth asserting: reusable, shareable, and for a bounded time. */
function expectExplicitlyReusable(hint: Hint, where: string): void {
  expect(hint.cacheScope, `${where} does not say who may cache it`).toBe("public");
  expect(hint.ttlMs, `${where} gives a lifetime of zero, which is the conservative default in disguise`)
    .toBe(CACHE_TTL_MS);
}

describe("a tool result", () => {
  /**
   * On the result, not only on the descriptor.
   *
   * A descriptor is read once at discovery and describes a capability; a client deciding whether to keep
   * the answer in front of it needs the statement attached to that answer. Both carry it, and this is the
   * one that was missing.
   */
  it("carries the hint on the answer itself, for every tool", async () => {
    const calls: readonly [string, Record<string, unknown>][] = [
      ["list_patterns", {}],
      ["describe_pattern", { pattern: "result" }],
      ["generate_pattern", { pattern: "result", identifiers: { entity: "Order" } }],
    ];

    for (const [name, args] of calls) {
      const result = await session.client.callTool({ name, arguments: args });
      expect(result.isError, `${name} was refused, so this asserts nothing`).not.toBe(true);
      expectExplicitlyReusable(hintOn(result._meta, `the ${name} result`), `the ${name} result`);
    }
  }, 120_000);

  it("carries it on the descriptor too, so a client can plan before calling", async () => {
    const { tools } = await session.client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      expectExplicitlyReusable(hintOn(tool._meta, `the ${tool.name} descriptor`), `the ${tool.name} descriptor`);
    }
  });

  it("says the same thing in both places, since they describe one answer", async () => {
    const { tools } = await session.client.listTools();
    const descriptor = tools.find((tool) => tool.name === "list_patterns");
    const result = await session.client.callTool({ name: "list_patterns", arguments: {} });

    expect(hintOn(result._meta, "the result")).toEqual(hintOn(descriptor?._meta, "the descriptor"));
  });
});

describe("a refusal", () => {
  it("is cacheable, because the request decided it", async () => {
    // The same bad request cannot be answered differently, so this is as reusable as a success. Leaving
    // it unstated invites a retry loop over a call whose outcome is fixed.
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "no-such-pattern" },
    });

    expect(result.isError).toBe(true);
    expectExplicitlyReusable(hintOn(result._meta, "a refusal"), "a refusal");
  });

  it("still carries the error code beside it, rather than one displacing the other", async () => {
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "no-such-pattern" },
    });

    expect(result._meta).toMatchObject({
      [ERROR_CODE_META_KEY]: "unknown_pattern",
      [CORRECTABLE_META_KEY]: true,
    });
  });
});

describe("the protocol's own cache fields", () => {
  /**
   * The declaration, against the revision's closed list.
   *
   * `revision.test.ts` reads these off the wire; this catches the thing the wire cannot, which is a method
   * *missing* from the set. Such a method would not fail — it would quietly take the SDK's fallback of a
   * zero lifetime and `private`, which is a wrong description that looks like caution.
   */
  it("are declared for every operation the revision makes cacheable", () => {
    expect(Object.keys(PROTOCOL_CACHE_HINTS).toSorted(), "a cacheable operation with no declared hint")
      .toEqual([...CACHEABLE_METHODS].toSorted());

    for (const [method, hint] of Object.entries(PROTOCOL_CACHE_HINTS)) {
      expectExplicitlyReusable(hint, method);
    }
  });

  /**
   * And the declaration is what the wire actually carries, on a session that speaks the revision.
   *
   * Through the typed client rather than raw frames, which is the interesting direction: it proves the
   * fields survive schema validation and reach a client as fields it can read, rather than being stripped
   * the way `resultType` is.
   */
  it("reach a client that speaks the revision", async () => {
    const modern = await connect("modern");
    try {
      expectExplicitlyReusable(
        (await modern.client.listTools()) as unknown as Hint,
        "tools/list on a modern session",
      );
      expectExplicitlyReusable(
        (await modern.client.listResources()) as unknown as Hint,
        "resources/list on a modern session",
      );
      expectExplicitlyReusable(
        (await modern.client.readResource({ uri: "pattern://catalog" })) as unknown as Hint,
        "resources/read on a modern session",
      );
    } finally {
      await modern.close();
    }
  });

  /**
   * A legacy client gets none of them, and that is the protocol's answer rather than ours: the fields do
   * not exist in `2025-11-25`. Worth pinning, because it is the reason `tools/call` is not the only result
   * that needs the `_meta` vehicle — for a legacy client, it is every result.
   */
  it("are absent for a legacy client, which is why _meta carries the hint as well", async () => {
    const tools = (await session.client.listTools()) as unknown as Hint;
    expect(session.era).toBe("legacy");
    expect(tools.ttlMs, "the revision's fields appeared on a session that predates them").toBeUndefined();
  });
});
