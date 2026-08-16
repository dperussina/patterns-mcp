/**
 * Schema validation resolves no external reference (FR-039).
 *
 * The requirement has two halves and they fail in opposite directions, so both are asserted here.
 *
 * **What we publish.** A `$ref` in a declared schema is an instruction to whoever validates against it,
 * and a client that follows one to an `https://` target has been made to fetch on our behalf — a request
 * we caused, to a host we named, on a schedule set by whoever calls the tool. Nothing here needs a
 * reference: the schemas are small and Zod inlines them, so the assertion is that this stays true rather
 * than that it was arranged.
 *
 * **What we accept.** Several fields take an open record — `prettierConfig` most obviously, since a
 * formatter's options are a caller's own JSON — so a caller can send us `$ref`, `$id` or `$schema` keys
 * whether or not they mean anything. None of them may be dereferenced. Zod has no resolver, which is
 * what makes this safe; the test is here because the safety is a property of the validator we chose, and
 * a change of validator is exactly the kind of change that would not look like it touched this.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { connect } from "./client.js";
import type { Session } from "./client.js";

let session: Session;

beforeAll(async () => {
  session = await connect();
});

afterAll(async () => {
  await session.close();
});

/**
 * A reference to somewhere else: another document, or a location this one does not define.
 *
 * `$schema` is deliberately not matched. It declares which dialect the document is written in, which
 * every JSON Schema carries and no validator fetches — it is compared as an identifier, not retrieved.
 * Treating it as a reference would make this fail on a correct schema, which is the surest way to get a
 * test switched off.
 */
const REFERENCE_KEYS = ["$ref", "$dynamicRef", "$defs", "definitions"] as const;

describe("the schemas we publish", () => {
  it("declare no reference for a client to follow", async () => {
    const { tools } = await session.client.listTools();
    expect(tools.length, "no tools would make this vacuous").toBeGreaterThan(0);

    for (const tool of tools) {
      const serialized = JSON.stringify({
        input: tool.inputSchema,
        output: tool.outputSchema,
      });

      for (const key of REFERENCE_KEYS) {
        expect(
          serialized.includes(`"${key}"`),
          `${tool.name} publishes ${key}, which asks its reader to resolve something`,
        ).toBe(false);
      }
    }
  });

  it("point at nothing remote except the dialect they are written in", async () => {
    const { tools } = await session.client.listTools();

    for (const tool of tools) {
      const serialized = JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema });
      const urls = [...serialized.matchAll(/"((?:https?:|file:)\/\/[^"]*)"/g)].map((match) => match[1]);

      // The meta-schema URL is the one legitimate occurrence, and it appears as `$schema`'s value.
      const unexpected = urls.filter((url) => url !== "https://json-schema.org/draft/2020-12/schema");
      expect(unexpected, `${tool.name} names a remote target in its schema`).toEqual([]);
    }
  });

  it("declare the dialect, so a validator has no reason to guess one", async () => {
    const { tools } = await session.client.listTools();

    for (const tool of tools) {
      expect(
        (tool.inputSchema as { $schema?: string }).$schema,
        `${tool.name} leaves the dialect unstated`,
      ).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });
});

describe("a reference in what a caller sends", () => {
  /**
   * The open records, each carrying something that would be dereferenced by a validator that resolved
   * references. `prettierConfig` is the one a caller might plausibly fill from a file they did not write.
   */
  const requests: readonly { readonly label: string; readonly args: Record<string, unknown> }[] = [
    {
      label: "prettierConfig",
      args: {
        pattern: "result",
        identifiers: { entity: "Order" },
        conventions: { prettierConfig: { $ref: "https://example.invalid/schema.json#/printWidth" } },
      },
    },
    {
      label: "options",
      args: {
        pattern: "result",
        identifiers: { entity: "Order" },
        options: { $ref: "https://example.invalid/options.json" },
      },
    },
    {
      label: "identifiers",
      args: {
        pattern: "result",
        identifiers: { entity: "Order", $ref: "file:///etc/passwd" },
      },
    },
  ];

  it.each(requests)("is not fetched: $label", async ({ args }) => {
    // Any resolution would go out through `fetch`: it is the only HTTP client in the runtime, and
    // neither the validator nor the formatter has another. A resolver would have to call this.
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("a schema reference was dereferenced");
    });

    try {
      const result = await session.client.callTool({ name: "generate_pattern", arguments: args });

      // Whether the request is served or refused is not the point and is asserted elsewhere; either is
      // a correct answer to a key we do not declare. What matters is that answering it fetched nothing.
      expect(fetched, "something dereferenced a caller-supplied reference").not.toHaveBeenCalled();
      expect(result, "and the request was still answered").toBeDefined();
    } finally {
      fetched.mockRestore();
    }
  }, 120_000);

  it("is not followed out of a resource URI either", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("a resource URI was dereferenced");
    });

    try {
      await expect(
        session.client.readResource({ uri: "pattern://catalog/https://example.invalid/x" }),
      ).rejects.toThrow();

      expect(fetched, "a resource name that looks like a URL is still just a name").not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });

  it("cannot smuggle a remote target through an unfetched reference: the value is not echoed either", async () => {
    // Belt and braces on FR-035's side of the same request. Not fetching it is the requirement; not
    // repeating it back is what stops a refusal from carrying the URL onward into another prompt.
    const result = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "result", identifiers: { entity: "https://example.invalid/x" } },
    });

    const text = (result.content as readonly { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("\n");

    expect(result.isError).toBe(true);
    expect(text).not.toContain("example.invalid");
  });
});
