/**
 * The catalogue as resources (contracts/mcp-resources.md, FR-014).
 *
 * The same catalogue is offered twice because tools and resources serve different readers: a tool is
 * called by a model, while a resource can be attached by an application and read by a person. Neither is
 * a substitute for the other.
 *
 * What they must never be is two answers. So these handlers call `listing` and `detail` — the very
 * functions the tools call — and serialise the result. Parity is therefore structural rather than
 * asserted: there is no second place where a summary's fields or a rule's wording could be decided
 * differently. The drift test in `test/contract/catalog-parity.test.ts` guards the arrangement, not the
 * data.
 */

import { ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import type { McpServer, ReadResourceResult } from "@modelcontextprotocol/server";

import { catalogOnce } from "../../engine/catalog/load.js";
import { safeMessage } from "../errors.js";
import { detail } from "../tools/describe.js";
import { listing } from "../tools/list.js";

export const CATALOG_URI = "pattern://catalog";
export const PATTERN_URI_TEMPLATE = "pattern://catalog/{name}";

const JSON_MIME = "application/json";

/**
 * A day, in milliseconds.
 *
 * The catalogue ships with the build, so it cannot change without a new package version and no TTL is
 * wrong on the data's own terms. The bound is chosen for the one case a longer one would break: an
 * upgraded deployment serving a client that still holds yesterday's answer. Over stdio even that cannot
 * happen — a new version is a new process — so this is the remote transport's number.
 */
const CACHE_TTL_MS = 86_400_000;

/** Cacheable by shared caches: the catalogue is public, identical for every caller, and carries no request state. */
export const CATALOG_CACHE_HINT = { ttlMs: CACHE_TTL_MS, cacheScope: "public" } as const;

/**
 * Two spaces, not none.
 *
 * A resource is read by people as well as programs, and indentation is the difference between a
 * catalogue a human can skim and one they have to pipe through a formatter. It costs bytes on a payload
 * that is cached for a day.
 */
function json(value: unknown): string {
  return JSON.stringify(value, undefined, 2);
}

export function registerCatalogResources(server: McpServer): void {
  server.registerResource(
    "catalog",
    CATALOG_URI,
    {
      title: "Pattern catalog",
      description:
        "Every pattern this server can generate, with the intent of each. Summaries only; read " +
        "pattern://catalog/{name} for one pattern's options and rules.",
      mimeType: JSON_MIME,
      cacheHint: CATALOG_CACHE_HINT,
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [{ uri: uri.href, mimeType: JSON_MIME, text: json(await listing()) }],
    }),
  );

  server.registerResource(
    "pattern",
    new ResourceTemplate(PATTERN_URI_TEMPLATE, {
      /**
       * Enumerated rather than left opaque. A template with no `list` is discoverable only by a client
       * that already knows a pattern name, which is precisely the knowledge a caller starting out does
       * not have; enumerating turns the catalogue into something an application can offer as a list of
       * attachable documents.
       */
      list: async () => {
        const catalog = await catalogOnce();
        return {
          resources: catalog.patterns.map((pattern) => ({
            uri: `${CATALOG_URI}/${pattern.name}`,
            name: pattern.name,
            title: pattern.title,
            description: pattern.intent,
            mimeType: JSON_MIME,
          })),
        };
      },
      complete: {
        /** Completion over names, so a client can offer them as the caller types. */
        name: async (value) => {
          const catalog = await catalogOnce();
          return catalog.patterns
            .map((pattern) => pattern.name)
            .filter((name) => name.startsWith(value));
        },
      },
    }),
    {
      title: "Pattern detail",
      description:
        "Full detail for one pattern: every option with its permitted values and default, and the " +
        "rules that will refuse a request. Mirrors describe_pattern.",
      mimeType: JSON_MIME,
      cacheHint: CATALOG_CACHE_HINT,
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const name = nameFrom(variables.name);

      try {
        return {
          contents: [{ uri: uri.href, mimeType: JSON_MIME, text: json(await detail(name)) }],
        };
      } catch (error) {
        // The URI is echoed because the protocol's own not-found data field is for exactly that, and a
        // client matching the response to its request needs it. The *message* is sanitised, which is
        // where a caller-supplied value could otherwise be read as prose (FR-035).
        throw new ResourceNotFoundError(uri.href, safeMessage(error));
      }
    },
  );
}

/**
 * A repeated template variable arrives as an array. Joining on `/` reconstructs what the caller wrote
 * rather than silently reading the first segment, so `pattern://catalog/a/b` is refused as the name
 * `a/b` — which it is — instead of quietly answering about `a`.
 *
 * An absent variable becomes the empty string, which no pattern is named, so it takes the not-found path
 * with the rest. Substituting a default would answer a question the caller did not ask.
 */
function nameFrom(value: string | readonly string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join("/") : (value as string);
}
