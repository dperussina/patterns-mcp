/**
 * The `repository` pattern: a typed collection interface over a datastore the caller supplies.
 *
 * This is the first pattern here that genuinely splits, and it is worth being precise about what the two
 * halves are. The *core* is a query language, a repository implementation over an abstract `Store`, and
 * an in-memory `Store` to develop and test against — none of which mentions a domain type. The *binding*
 * is small and entirely about one entity: its key type, its collection name, and a factory that hands
 * back a repository typed to it. A project with eleven entities wants one core and eleven bindings, and
 * `emitScope: "binding-only"` is how the twelfth arrives without re-sending the machinery (FR-017).
 *
 * The core is deliberately a single file rather than a `types` file plus a `core` file. A binding-only
 * request repoints its imports at the one module the caller already has, and two core files would mean
 * two specifiers to repoint from one `coreModule` value — either the caller supplies two, or we guess.
 *
 * Two decisions inside the emitted code are worth reading twice.
 *
 * **The `Store` seam is untyped by collection and generic by method.** `read<T>(collection, key)` trusts
 * the adapter to return that collection's shape. That is unsound in the way every persistence boundary
 * is unsound — the database does not know your types — and putting the cast in one named place is the
 * point: the repository above it is fully typed, and the adapter below it is the one file where a caller
 * has to be careful.
 *
 * **Comparisons carry a brand.** A filter allows a bare value as shorthand for equality, so
 * `{ status: "open" }` works, and that shorthand makes `{ status: someObject }` ambiguous the moment a
 * caller's own data happens to look like a comparison. An exported `unique symbol` on every comparison
 * removes the ambiguity: caller data cannot carry it by accident.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { standIn, withNoun } from "../../options/names.js";
import {
  dedent,
  doc,
  docAt,
  documented,
  joinLines,
  sections,
  when,
} from "../../render/helpers.js";
import { expectFileEntry, frameworkImports } from "../expect-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

type Pagination = "cursor" | "offset" | "none";

interface Shape {
  readonly pagination: Pagination;
  /** `idStyle: "branded"` — the key is a distinct type rather than an alias for `string`. */
  readonly branded: boolean;
  /**
   * `emitScope: "core-only"` — there is no binding file, so the example and the suite declare the
   * binding they demonstrate instead of importing one this scope does not emit.
   */
  readonly standalone: boolean;
}

interface Names {
  /**
   * Entity-independent by definition: it is the file every binding imports, so naming it after one
   * entity would give the second binding a core named after the first.
   */
  readonly coreStem: string;
  readonly bindingStem: string;
  readonly entity: string;
  /**
   * What the example calls its stand-in for the caller's type, which is the caller's own name unless
   * something in that file already answers to it (FR-052).
   */
  readonly sampleType: string;
  /** Whether the stand-in had to step aside, so the example can say why it is not called what you asked. */
  readonly renamedSample: boolean;
  readonly collection: string;
  readonly idType: string;
  readonly idFactory: string;
  readonly recordType: string;
  readonly factory: string;
  /** What a repository variable is called in the example and the suite: `orders`, not `orderRepo`. */
  readonly instance: string;
  /** The example's entry point. */
  readonly exampleFn: string;
  /** The screaming-snake constant the binding exports for its collection. */
  readonly specConst: string;
}

export const CORE_STEM = "repository-core";

/**
 * The core's exports, which the example and the suite import by name.
 *
 * Listed so that a caller's entity landing on one of them makes the example's stand-in step aside
 * instead of being declared twice in the same module (FR-052).
 */
const DECLARED: readonly string[] = [
  "CollectionSpec",
  "DuplicateRecordError",
  "KeyChangedError",
  "MemoryStore",
  "Page",
  "RecordNotFoundError",
  "Repository",
  "Store",
];

export const repositoryPattern: PatternModule = {
  name: "repository",

  /**
   * The core's own repository type, which the binding imports. An entity of `Repository` collapses to
   * exactly that — factory and type both — so the binding would import a name and export it. The
   * example's stand-in can step aside; an exported binding cannot, because the caller builds against it.
   */
  emits: ["Repository"],

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      pagination: paginationOf(options.pagination),
      branded: options.idStyle !== "plain",
      standalone: options.emitScope === "core-only",
    };
    const names = namesFor(context);

    // Named after whichever half the file demonstrates, so a `core-only` caller's example is not called
    // after a binding they were not sent.
    const demoStem = shape.standalone ? names.coreStem : names.bindingStem;

    const files: RenderedFile[] = [
      { path: `${names.coreStem}.ts`, role: "core", contents: core(shape) },
      {
        path: `${names.bindingStem}.ts`,
        role: "binding",
        contents: binding(context, names, shape),
      },
      {
        path: `${demoStem}-example.ts`,
        role: "example",
        contents: example(context, names, shape),
      },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({
        path: `${demoStem}.test.ts`,
        role: "test",
        contents: tests(context, names, shape),
      });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

function paginationOf(value: unknown): Pagination {
  return value === "offset" || value === "none" ? value : "cursor";
}

function core(shape: Shape): string {
  return sections(
    coreHeader(shape),
    comparisonTypes(),
    whereType(),
    sortType(),
    listTypes(shape),
    storeType(shape),
    specType(),
    errorClasses(),
    repositoryType(shape),
    createRepositoryFunction(shape),
    matchingHelpers(),
    memoryStore(shape),
  );
}

function coreHeader(shape: Shape): string {
  const paging =
    shape.pagination === "cursor"
      ? "Listing is cursor-paged. A cursor is the key of the last record returned, which is why every query is given a total order — without one, a record inserted between two pages would be returned twice or not at all."
      : shape.pagination === "offset"
        ? "Listing is offset-paged, and reports the matching total alongside the page. Note the cost: an offset page is only consistent if nothing is inserted between requests, so a record added during paging can shift every subsequent page by one."
        : "Listing returns every matching record. There is no paging here, so a query that matches a large collection loads all of it.";

  return doc(
    "A repository over a collection, and the query language it accepts.",
    "Nothing here mentions a domain type. This module is the machinery every entity's repository shares; each entity gets a small binding of its own that supplies its key type and collection name.",
    paging,
    "`Store` is the seam. Implement it once for your datastore and every repository in the project goes through it; `createMemoryStore` is a complete implementation for tests and for development before the real one exists.",
  );
}

function comparisonTypes(): string {
  return sections(
    documented(
      [
        "The marker that distinguishes a comparison from a value.",
        'A filter accepts a bare value as shorthand for equality, so `{ status: "open" }` means what it looks like. That shorthand is what makes this symbol necessary: without it, a field whose value is an object with a `kind` property would be indistinguishable from a comparison, and the filter would silently interpret your data as an instruction.',
      ],
      'export const COMPARISON: unique symbol = Symbol("repository.comparison");',
    ),
    documented(
      ["How one field is compared. Build these with the helpers below rather than by hand."],
      dedent`
      export type Comparison<V> = {
        readonly [COMPARISON]: true;
      } & (
        | { readonly kind: "eq"; readonly value: V }
        | { readonly kind: "ne"; readonly value: V }
        | { readonly kind: "in"; readonly values: readonly V[] }
        | { readonly kind: "gt"; readonly value: V }
        | { readonly kind: "gte"; readonly value: V }
        | { readonly kind: "lt"; readonly value: V }
        | { readonly kind: "lte"; readonly value: V }
      );
    `,
    ),
    documented(
      [
        "Comparison constructors.",
        "`oneOf` rather than `in`, and `not` rather than `ne`, because `in` is a reserved word and an exported `ne` reads as a typo. The `kind` values keep the operator names a datastore adapter will recognise.",
      ],
      dedent`
      export function eq<V>(value: V): Comparison<V> {
        return { [COMPARISON]: true, kind: "eq", value };
      }

      export function not<V>(value: V): Comparison<V> {
        return { [COMPARISON]: true, kind: "ne", value };
      }

      export function oneOf<V>(values: readonly V[]): Comparison<V> {
        return { [COMPARISON]: true, kind: "in", values };
      }

      export function gt<V>(value: V): Comparison<V> {
        return { [COMPARISON]: true, kind: "gt", value };
      }

      export function gte<V>(value: V): Comparison<V> {
        return { [COMPARISON]: true, kind: "gte", value };
      }

      export function lt<V>(value: V): Comparison<V> {
        return { [COMPARISON]: true, kind: "lt", value };
      }

      export function lte<V>(value: V): Comparison<V> {
        return { [COMPARISON]: true, kind: "lte", value };
      }
    `,
    ),
  );
}

function whereType(): string {
  return documented(
    [
      "A filter over a record: every field named must match.",
      "A field may be given a value, meaning equality, or a comparison. Fields not named are not constrained.",
    ],
    dedent`
      export type Where<T> = {
        readonly [K in keyof T]?: T[K] | Comparison<T[K]>;
      };
    `,
  );
}

function sortType(): string {
  return documented(
    ["One level of ordering. Several may be given, applied in order."],
    dedent`
      export interface Sort<T> {
        readonly field: keyof T & string;
        readonly direction: "asc" | "desc";
      }
    `,
  );
}

function listTypes(shape: Shape): string {
  if (shape.pagination === "none") {
    return documented(
      ["What `list` accepts."],
      dedent`
        export interface ListOptions<T> {
          readonly where?: Where<T> | undefined;
          readonly sort?: readonly Sort<T>[] | undefined;
        }
      `,
    );
  }

  const cursorOptions = dedent`
    export interface ListOptions<T> {
      readonly where?: Where<T> | undefined;
      readonly sort?: readonly Sort<T>[] | undefined;
      readonly limit?: number | undefined;
      ${docAt(2, "The `cursor` of the previous page. Omit for the first page.")}
      readonly after?: string | undefined;
    }
  `;

  const offsetOptions = dedent`
    export interface ListOptions<T> {
      readonly where?: Where<T> | undefined;
      readonly sort?: readonly Sort<T>[] | undefined;
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    }
  `;

  const cursorPage = dedent`
    export interface Page<T> {
      readonly items: readonly T[];
      ${docAt(2, "Pass as `after` to continue. Undefined when this is the last page.")}
      readonly cursor: string | undefined;
      readonly hasMore: boolean;
    }
  `;

  const offsetPage = dedent`
    export interface Page<T> {
      readonly items: readonly T[];
      ${docAt(2, "Records matching the filter, ignoring `limit` and `offset`.")}
      readonly total: number;
      readonly offset: number;
      readonly hasMore: boolean;
    }
  `;

  return sections(
    documented(
      ["What `list` accepts."],
      shape.pagination === "cursor" ? cursorOptions : offsetOptions,
    ),
    documented(
      ["One page of results."],
      shape.pagination === "cursor" ? cursorPage : offsetPage,
    ),
  );
}

function storeType(shape: Shape): string {
  const window =
    shape.pagination === "cursor"
      ? joinLines(
          docAt(2, "Return records strictly after the one whose key equals this. Undefined starts at the beginning."),
          "readonly after: string | undefined;",
        )
      : shape.pagination === "offset"
        ? joinLines(
            docAt(2, "Records to skip before collecting the page."),
            "readonly skip: number | undefined;",
          )
        : "";

  return sections(
    documented(
      [
        "A query as the store receives it: complete, with the repository's defaults already applied.",
        "The store is handed a total order rather than the caller's partial one, so an adapter never has to decide how to break a tie.",
      ],
      dedent`
      export interface StoreQuery<T> {
        readonly where: Where<T> | undefined;
        readonly sort: readonly Sort<T>[];
        ${docAt(2, "The field holding each record's key, for ordering and for cursors.")}
        readonly keyField: string;
        readonly limit: number | undefined;
      ${when(window !== "", `  ${window}`)}
      }
    `,
    ),
    documented(
      [
        "The datastore seam: implement once per datastore, share across every repository.",
        "Each method is generic in the record type, which means the implementation is trusted to return the shape the collection holds. That is the unsoundness every persistence boundary has — a database does not know your types — and it is confined here on purpose, so that the repository above is fully typed and this file is the only one where a caller has to be careful.",
      ],
      dedent`
      export interface Store {
        read<T>(collection: string, key: string): Promise<T | undefined>;
        readMany<T>(collection: string, keys: readonly string[]): Promise<readonly T[]>;
        query<T>(collection: string, query: StoreQuery<T>): Promise<readonly T[]>;
        count<T>(collection: string, where: Where<T> | undefined): Promise<number>;
        write<T>(collection: string, key: string, record: T): Promise<void>;
        remove(collection: string, key: string): Promise<boolean>;
      }
    `,
    ),
  );
}

function specType(): string {
  return documented(
    [
      "What a binding tells the core about one collection.",
      "`keyField` and `key` are both required and must agree: the first is how a query orders and pages, the second is how a record in hand yields its key. Deriving one from the other would mean either reading a field by name and casting, or calling a function on a record the store has not returned yet.",
    ],
    dedent`
      export interface CollectionSpec<T, K extends string> {
        readonly collection: string;
        readonly keyField: keyof T & string;
        key(record: T): K;
      }
    `,
  );
}

function errorClasses(): string {
  return sections(
    documented(
      [
        "A record that had to exist did not.",
        "Thrown by `require` and `update`, and not by `get`: a lookup that may legitimately find nothing returns `undefined`, and a lookup whose caller has already decided the record must be there gets an error naming what was missing.",
      ],
      dedent`
      export class RecordNotFoundError extends Error {
        readonly collection: string;
        readonly key: string;

        constructor(collection: string, key: string) {
          super(\`No record in "\${collection}" with key "\${key}".\`);
          this.name = "RecordNotFoundError";
          this.collection = collection;
          this.key = key;
        }
      }
    `,
    ),
    documented(
      ["`insert` was given a key that is already present. Use `upsert` to overwrite deliberately."],
      dedent`
      export class DuplicateRecordError extends Error {
        readonly collection: string;
        readonly key: string;

        constructor(collection: string, key: string) {
          super(\`A record in "\${collection}" already has key "\${key}".\`);
          this.name = "DuplicateRecordError";
          this.collection = collection;
          this.key = key;
        }
      }
    `,
    ),
    documented(
      [
        "An update tried to change the key it was addressed by.",
        "Refused rather than applied, because applying it means one of two things the caller did not ask for: a second record under the new key, or a silent delete of the old one.",
      ],
      dedent`
      export class KeyChangedError extends Error {
        readonly collection: string;
        readonly from: string;
        readonly to: string;

        constructor(collection: string, from: string, to: string) {
          super(
            \`An update to "\${from}" in "\${collection}" would change its key to "\${to}". \` +
              \`Delete and insert instead, so that both records are accounted for.\`,
          );
          this.name = "KeyChangedError";
          this.collection = collection;
          this.from = from;
          this.to = to;
        }
      }
    `,
    ),
  );
}

function matchingHelpers(): string {
  return sections(
    documented(
      [
        "Whether a record satisfies a filter.",
        "Exported because a datastore adapter that cannot express the whole filter in its own query language needs to finish the job in memory, and doing that with a second implementation of these rules is how a filter comes to mean two different things depending on which store is behind it.",
      ],
      dedent`
      export function matchesWhere<T>(record: T, where: Where<T> | undefined): boolean {
        if (where === undefined) {
          return true;
        }

        for (const [field, expected] of Object.entries(where)) {
          const actual = (record as Record<string, unknown>)[field];
          if (!matchesField(actual, expected)) {
            return false;
          }
        }

        return true;
      }
    `,
    ),
    dedent`
      function matchesField(actual: unknown, expected: unknown): boolean {
        if (!isComparison(expected)) {
          return actual === expected;
        }

        switch (expected.kind) {
          case "eq":
            return actual === expected.value;
          case "ne":
            return actual !== expected.value;
          case "in":
            return expected.values.includes(actual);
          case "gt":
            return compareValues(actual, expected.value) > 0;
          case "gte":
            return compareValues(actual, expected.value) >= 0;
          case "lt":
            return compareValues(actual, expected.value) < 0;
          case "lte":
            return compareValues(actual, expected.value) <= 0;
        }
      }
    `,
    dedent`
      function isComparison(value: unknown): value is Comparison<unknown> {
        return typeof value === "object" && value !== null && COMPARISON in value;
      }
    `,
    documented(
      [
        "Orders two field values.",
        "Strings compare by code unit rather than by locale. `localeCompare` would order the same two records differently depending on the ICU data the host was built with, so a paged query could return a record twice on one machine and never on another.",
        "Anything not comparable throws rather than sorting arbitrarily: a silent zero here would make `list` return records in an order that looks stable and is not.",
      ],
      dedent`
      export function compareValues(left: unknown, right: unknown): number {
        if (typeof left === "string" && typeof right === "string") {
          return left < right ? -1 : left > right ? 1 : 0;
        }
        if (typeof left === "number" && typeof right === "number") {
          return left - right;
        }
        if (typeof left === "boolean" && typeof right === "boolean") {
          return Number(left) - Number(right);
        }
        if (typeof left === "bigint" && typeof right === "bigint") {
          return left < right ? -1 : left > right ? 1 : 0;
        }
        if (left instanceof Date && right instanceof Date) {
          return left.getTime() - right.getTime();
        }
        if (left === undefined || left === null) {
          return right === undefined || right === null ? 0 : -1;
        }
        if (right === undefined || right === null) {
          return 1;
        }

        throw new TypeError(
          \`Cannot order \${typeof left} against \${typeof right}. Sort and compare only fields \` +
            \`holding strings, numbers, booleans, bigints, or dates.\`,
        );
      }
    `,
    ),
    documented(
      [
        "Applies an ordering. Exported for the same reason as `matchesWhere`.",
        "Copied before sorting rather than sorted in place, since a caller who passed an array they still hold would otherwise find it reordered. `toSorted` would say this more directly and is ES2023, which a caller targeting anything older does not have.",
      ],
      dedent`
      export function sortRecords<T>(records: readonly T[], sort: readonly Sort<T>[]): readonly T[] {
        return [...records].sort((left: T, right: T) => {
          for (const level of sort) {
            const compared = compareValues(
              (left as Record<string, unknown>)[level.field],
              (right as Record<string, unknown>)[level.field],
            );
            if (compared !== 0) {
              return level.direction === "desc" ? -compared : compared;
            }
          }
          return 0;
        });
      }
    `,
    ),
  );
}

function memoryStore(shape: Shape): string {
  const windowing =
    shape.pagination === "cursor"
      ? dedent`
          const start =
            query.after === undefined
              ? 0
              : ordered.findIndex(
                  (record) => String((record as Record<string, unknown>)[query.keyField]) === query.after,
                ) + 1;
          // A cursor naming a record that has since been deleted returns nothing rather than silently
          // restarting from the beginning, which would hand the caller the first page a second time.
          const windowed =
            query.after !== undefined && start === 0 ? [] : ordered.slice(start);
        `
      : shape.pagination === "offset"
        ? "const windowed = ordered.slice(query.skip ?? 0);"
        : "const windowed = ordered;";

  return documented(
    [
      "A complete `Store` held in memory.",
      "Not a mock: it implements the whole seam, including ordering and paging, so a suite written against it exercises the repository rather than a stand-in for it. That is what makes the emitted tests worth running before any datastore exists.",
      "Insertion order is never relied on — every query is ordered by the total order the repository supplies — so two runs return the same records in the same sequence.",
    ],
    dedent`
      export function createMemoryStore(): Store {
        const collections = new Map<string, Map<string, unknown>>();

        const rowsIn = (collection: string): Map<string, unknown> => {
          const existing = collections.get(collection);
          if (existing !== undefined) {
            return existing;
          }
          const created = new Map<string, unknown>();
          collections.set(collection, created);
          return created;
        };

        return {
          read<T>(collection: string, key: string): Promise<T | undefined> {
            return Promise.resolve(rowsIn(collection).get(key) as T | undefined);
          },

          readMany<T>(collection: string, keys: readonly string[]): Promise<readonly T[]> {
            const rows = rowsIn(collection);
            const found: T[] = [];
            for (const key of keys) {
              const row = rows.get(key);
              if (row !== undefined) {
                found.push(row as T);
              }
            }
            return Promise.resolve(found);
          },

          query<T>(collection: string, query: StoreQuery<T>): Promise<readonly T[]> {
            const matching = [...rowsIn(collection).values()].filter((row) =>
              matchesWhere(row as T, query.where),
            ) as T[];
            const ordered = sortRecords(matching, query.sort);
            ${windowing}

            return Promise.resolve(
              query.limit === undefined ? windowed : windowed.slice(0, query.limit),
            );
          },

          count<T>(collection: string, where: Where<T> | undefined): Promise<number> {
            const matching = [...rowsIn(collection).values()].filter((row) =>
              matchesWhere(row as T, where),
            );
            return Promise.resolve(matching.length);
          },

          write<T>(collection: string, key: string, record: T): Promise<void> {
            rowsIn(collection).set(key, record);
            return Promise.resolve();
          },

          remove(collection: string, key: string): Promise<boolean> {
            return Promise.resolve(rowsIn(collection).delete(key));
          },
        };
      }
    `,
  );
}


function repositoryType(shape: Shape): string {
  const listReturn = shape.pagination === "none" ? "Promise<readonly T[]>" : "Promise<Page<T>>";
  const listDoc =
    shape.pagination === "none"
      ? "Every matching record, in the requested order."
      : "One page of matching records, in the requested order.";

  return documented(
    [
      "A typed collection.",
      "The surface is deliberately complete rather than minimal. A repository a caller has to reach around — because it can fetch one record but not many, or insert but not upsert — gets reached around immediately, and the datastore access it was meant to contain ends up spread through the code that uses it.",
    ],
    dedent`
      export interface Repository<T, K extends string> {
        ${docAt(2, "The record, or `undefined` when there is none.")}
        get(key: K): Promise<T | undefined>;
        ${docAt(2, "The record, or a `RecordNotFoundError`. For callers who have already established it exists.")}
        require(key: K): Promise<T>;
        ${docAt(2, "The records that exist, in the order the keys were given. Missing keys are skipped rather than reported.")}
        getMany(keys: readonly K[]): Promise<readonly T[]>;
        ${docAt(2, "The first record matching the filter, or `undefined`.")}
        findOne(where: Where<T>): Promise<T | undefined>;
        ${docAt(2, listDoc)}
        list(options?: ListOptions<T>): ${listReturn};
        ${docAt(2, "How many records match. Counts the whole collection when no filter is given.")}
        count(where?: Where<T>): Promise<number>;
        exists(key: K): Promise<boolean>;
        ${docAt(2, "Stores a record that is not there yet.\n@throws DuplicateRecordError when the key is taken.")}
        insert(record: T): Promise<T>;
        ${docAt(2, "Inserts each record in order, stopping at the first that is already present. Not atomic: a store with transactions should wrap the call, since this cannot know how.")}
        insertMany(records: readonly T[]): Promise<readonly T[]>;
        ${docAt(2, "Applies changes to an existing record and returns the result.\n@throws RecordNotFoundError when there is nothing at `key`.\n@throws KeyChangedError when the changes would move the record.")}
        update(key: K, changes: Partial<T>): Promise<T>;
        ${docAt(2, "Stores a record whether or not it is already there.")}
        upsert(record: T): Promise<T>;
        ${docAt(2, "Whether a record was removed. `false` means there was nothing to remove.")}
        delete(key: K): Promise<boolean>;
      }
    `,
  );
}

function createRepositoryFunction(shape: Shape): string {
  return documented(
    [
      "A repository over `store` for the collection `spec` describes.",
      "Every method is expressed in terms of the six `Store` operations, so a new datastore costs one adapter and no repository code at all.",
    ],
    dedent`
      export function createRepository<T, K extends string>(
        store: Store,
        spec: CollectionSpec<T, K>,
      ): Repository<T, K> {
        ${indentedTotalOrder()}

        const repository: Repository<T, K> = {
          async get(key: K): Promise<T | undefined> {
            return await store.read<T>(spec.collection, key);
          },

          async require(key: K): Promise<T> {
            const found = await store.read<T>(spec.collection, key);
            if (found === undefined) {
              throw new RecordNotFoundError(spec.collection, key);
            }
            return found;
          },

          async getMany(keys: readonly K[]): Promise<readonly T[]> {
            return await store.readMany<T>(spec.collection, keys);
          },

          async findOne(where: Where<T>): Promise<T | undefined> {
            const found = await store.query<T>(spec.collection, {
              where,
              sort: totalOrder(undefined),
              keyField: spec.keyField,
              limit: 1,
      ${when(shape.pagination === "cursor", "        after: undefined,")}${when(shape.pagination === "offset", "        skip: undefined,")}
            });
            return found[0];
          },

          ${indentedList(shape)},

          async count(where?: Where<T>): Promise<number> {
            return await store.count<T>(spec.collection, where);
          },

          async exists(key: K): Promise<boolean> {
            return (await store.read<T>(spec.collection, key)) !== undefined;
          },

          async insert(record: T): Promise<T> {
            const key = spec.key(record);
            if ((await store.read<T>(spec.collection, key)) !== undefined) {
              throw new DuplicateRecordError(spec.collection, key);
            }
            await store.write<T>(spec.collection, key, record);
            return record;
          },

          async insertMany(records: readonly T[]): Promise<readonly T[]> {
            const inserted: T[] = [];
            // Sequential, not concurrent: two records with the same key must produce a duplicate error
            // rather than a race, and a store without transactions cannot be asked for more than this.
            for (const record of records) {
              inserted.push(await repository.insert(record));
            }
            return inserted;
          },

          async update(key: K, changes: Partial<T>): Promise<T> {
            const existing = await repository.require(key);
            const updated = { ...existing, ...changes };
            const moved = spec.key(updated);
            if (moved !== key) {
              throw new KeyChangedError(spec.collection, key, moved);
            }
            await store.write<T>(spec.collection, key, updated);
            return updated;
          },

          async upsert(record: T): Promise<T> {
            await store.write<T>(spec.collection, spec.key(record), record);
            return record;
          },

          async delete(key: K): Promise<boolean> {
            return await store.remove(spec.collection, key);
          },
        };

        return repository;
      }
    `,
  );
}

/**
 * The ordering helper, rendered at the indentation it sits at inside `createRepository`.
 *
 * Separate because its comment is the one a reader of the generated file most needs: the tiebreaker is
 * not a detail, it is what makes paging correct.
 */
function indentedTotalOrder(): string {
  return dedent`
    /**
     * The caller's ordering, with the key appended as a tiebreaker.
     *
     * A sort that does not fully determine an order leaves the store free to return equal records in
     * any sequence, and two requests for consecutive pages would then disagree about where the boundary
     * was — returning one record twice and another not at all. Appending the key costs nothing and makes
     * that impossible.
     */
    const totalOrder = (requested: readonly Sort<T>[] | undefined): readonly Sort<T>[] => {
      const levels = requested ?? [];
      return levels.some((level) => level.field === spec.keyField)
        ? levels
        : [...levels, { field: spec.keyField, direction: "asc" }];
    };
  `;
}

function indentedList(shape: Shape): string {
  if (shape.pagination === "none") {
    return dedent`
      async list(options?: ListOptions<T>): Promise<readonly T[]> {
        return await store.query<T>(spec.collection, {
          where: options?.where,
          sort: totalOrder(options?.sort),
          keyField: spec.keyField,
          limit: undefined,
        });
      }
    `;
  }

  if (shape.pagination === "offset") {
    return dedent`
      async list(options?: ListOptions<T>): Promise<Page<T>> {
        const offset = options?.offset ?? 0;
        const limit = options?.limit;
        const [items, total] = await Promise.all([
          store.query<T>(spec.collection, {
            where: options?.where,
            sort: totalOrder(options?.sort),
            keyField: spec.keyField,
            limit,
            skip: offset,
          }),
          store.count<T>(spec.collection, options?.where),
        ]);

        return { items, total, offset, hasMore: offset + items.length < total };
      }
    `;
  }

  return dedent`
    async list(options?: ListOptions<T>): Promise<Page<T>> {
      const limit = options?.limit;
      // One row more than asked for, so that \`hasMore\` is known without a second query. The extra
      // row is dropped before returning, which is why \`items\` is sliced rather than passed through.
      const rows = await store.query<T>(spec.collection, {
        where: options?.where,
        sort: totalOrder(options?.sort),
        keyField: spec.keyField,
        limit: limit === undefined ? undefined : limit + 1,
        after: options?.after,
      });

      const hasMore = limit !== undefined && rows.length > limit;
      const items = hasMore && limit !== undefined ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];

      return {
        items,
        hasMore,
        cursor: hasMore && last !== undefined ? spec.key(last) : undefined,
      };
    }
  `;
}

/**
 * The per-entity half. Everything here is about one domain type, and nothing here is machinery — which
 * is what makes `binding-only` worth having: this file is a small fraction of the core beside it.
 */
function binding(context: RenderContext, names: Names, shape: Shape): string {
  return sections(
    doc(
      `The ${names.entity} repository: this entity's key type, its collection, and a factory.`,
      `The machinery lives in \`${names.coreStem}\` and is shared with every other entity's repository. Adding a second entity means a second file like this one, not a second copy of that.`,
    ),
    importsFrom(context.conventions, siblingSpecifier(context.conventions, names.coreStem), {
      values: ["createRepository"],
      types: ["CollectionSpec", "Repository", "Store"],
    }),
    bindingBody(names, shape),
  );
}

/**
 * The binding's declarations, without its imports or header.
 *
 * Separate because `core-only` has no binding file and its example and suite still need one to
 * demonstrate: a caller adopting the machinery is about to write exactly this, so it is declared inline
 * there rather than imported from a file that scope does not emit (see `assertSelfContained`).
 */
function bindingBody(names: Names, shape: Shape): string {
  const idSection = shape.branded
    ? sections(
        documented(
          [
            `The key type for \`${names.entity}\`, distinct from every other kind of key.`,
            `The brand is what stops \`${names.idType}\` and some other entity's id from being interchangeable. They are both strings at runtime, and without this the compiler would accept either wherever the other is expected — which is the mistake that shows up as a lookup that finds nothing for a reason nobody can see.`,
          ],
          dedent`
            declare const ${names.idFactory}Brand: unique symbol;

            export type ${names.idType} = string & { readonly [${names.idFactory}Brand]: true };
          `,
        ),
        documented(
          [
            `The only constructor for \`${names.idType}\`, so every key in the program has been through this check.`,
            "@throws TypeError when the value is empty or padded, since a key that differs from another only by whitespace is a bug waiting for a support ticket.",
          ],
          dedent`
            export function ${names.idFactory}(value: string): ${names.idType} {
              if (value === "" || value.trim() !== value) {
                throw new TypeError(
                  "${names.idType} must be a non-empty string with no surrounding whitespace.",
                );
              }
              return value as ${names.idType};
            }
          `,
        ),
      )
    : documented(
        [
          `The key type for \`${names.entity}\`.`,
          `An alias rather than a distinct type, which means the compiler will accept any string here — including another entity's id. \`idStyle: "branded"\` closes that gap if you want it closed.`,
        ],
        `export type ${names.idType} = string;`,
      );

  return sections(
    idSection,
    documented(
      [
        `The minimum \`${names.entity}\` must have to be stored: its key.`,
        `Your own \`${names.entity}\` satisfies this by having an \`id\`, so nothing here needs to know the rest of its fields. That is deliberate — a generated file that declared your domain type would have to be edited every time the domain changed, and regenerating it would then overwrite the edit.`,
      ],
      dedent`
        export interface ${names.recordType} {
          readonly id: ${names.idType};
        }
      `,
    ),
    documented(
      [
        `Where ${names.entity} records live, and how one yields its key.`,
        "Exported so that a datastore adapter can be told which collections exist without importing every entity's factory.",
      ],
      dedent`
        export const ${names.specConst}: CollectionSpec<${names.recordType}, ${names.idType}> = {
          collection: "${names.collection}",
          keyField: "id",
          key: (record) => record.id,
        };
      `,
    ),
    documented(
      [
        `A repository over ${names.collection}, typed to your own \`${names.entity}\`.`,
        `Pass your domain type: \`${names.factory}<${names.entity}>(store)\`. The constraint is only that it has an \`id\`, so every method is typed in terms of your type rather than ours.`,
      ],
      dedent`
      export function ${names.factory}<T extends ${names.recordType}>(
        store: Store,
      ): Repository<T, ${names.idType}> {
        return createRepository<T, ${names.idType}>(store, {
          collection: ${names.specConst}.collection,
          keyField: "id",
          key: (record) => record.id,
        });
      }
    `,
    ),
  );
}

/**
 * A usage example, which FR-004 requires of every generative pattern and which is not the test file.
 *
 * The difference is what each is for: the suite proves the machinery correct and reads like a suite,
 * while this shows what a caller writes on their first day and reads like their code.
 */
function example(context: RenderContext, names: Names, shape: Shape): string {
  const coreSpec = siblingSpecifier(context.conventions, names.coreStem);
  const bindingSpec = siblingSpecifier(context.conventions, names.bindingStem);
  const inlineBinding = shape.standalone;
  const it = names.instance;
  const key = keyLiteral(names, shape);

  const listing =
    shape.pagination === "cursor"
      ? dedent`
        // A page at a time. \`cursor\` is undefined once nothing follows this page.
        const first = await ${it}.list({ where: { status: "open" }, limit: 1 });
        const second = await ${it}.list({
          where: { status: "open" },
          limit: 1,
          after: first.cursor,
        });

        return [...first.items, ...second.items];
      `
      : shape.pagination === "offset"
        ? dedent`
          // A page at a time, with the matching total alongside it.
          const page = await ${it}.list({ where: { status: "open" }, limit: 10, offset: 0 });
          report(\`\${String(page.items.length)} of \${String(page.total)} open\`);

          return page.items;
        `
        : dedent`
          const open = await ${it}.list({ where: { status: "open" } });
          report(\`\${String(open.length)} open\`);

          return open;
        `;

  const counting = dedent`
    // Comparisons are values, so a filter can be built up rather than written out.
    const large = await ${it}.count({ total: gt(100) });
    report(\`\${String(large)} over 100\`);
  `;

  return sections(
    doc(
      `Using the ${names.entity} repository.`,
      "The store here is the in-memory one, which is a complete implementation rather than a stand-in: swap it for your datastore's adapter and nothing below this line changes.",
    ),
    importsFrom(context.conventions, coreSpec, {
      values: ["createMemoryStore", "gt", ...(inlineBinding ? ["createRepository"] : [])],
      types: inlineBinding ? ["CollectionSpec", "Repository", "Store"] : [],
    }),
    when(
      !inlineBinding,
      importsFrom(context.conventions, bindingSpec, {
        values: [names.factory, ...(shape.branded ? [names.idFactory] : [])],
        types: [names.recordType],
      }),
    ),
    when(
      inlineBinding,
      sections(
        doc(
          "The binding this example uses, which a full bundle would have as its own file.",
          `This scope emitted the machinery alone, so what a binding looks like is shown here rather than left to be inferred: one of these per entity, and \`emitScope: "binding-only"\` generates the next one.`,
        ),
        bindingBody(names, shape),
      ),
    ),
    documented(
      [
        `Your own \`${names.entity}\`, which the repository is typed in terms of.`,
        `It extends \`${names.recordType}\` only to say that its key is an \`${names.idType}\`. Every other field is yours, and nothing generated needs to know about them.`,
        ...(names.renamedSample
          ? [
              `Called \`${names.sampleType}\` in this file only because \`${names.entity}\` is already the name of something it imports. Yours keeps the name you asked for.`,
            ]
          : []),
      ],
      dedent`
        export interface ${names.sampleType} extends ${names.recordType} {
          readonly status: "open" | "closed";
          readonly total: number;
        }
      `,
    ),
    dedent`
      export async function ${names.exampleFn}(): Promise<readonly ${names.sampleType}[]> {
        const ${it} = ${names.factory}<${names.sampleType}>(createMemoryStore());

        await ${it}.insertMany([
          { id: ${key("first")}, status: "open", total: 120 },
          { id: ${key("second")}, status: "open", total: 80 },
          { id: ${key("third")}, status: "closed", total: 20 },
        ]);

        // Changes are applied to the record as it stands, so this is not a blind overwrite.
        await ${it}.update(${key("second")}, { total: 95 });

        ${counting}

        ${listing}
      }
    `,
    documented(
      ["Stands in for whatever this program logs with."],
      dedent`
        function report(message: string): void {
          // eslint-disable-next-line no-console
          console.log(message);
        }
      `,
    ),
  );
}

/**
 * How the example and the suite write a key.
 *
 * Branded keys have to go through the factory, and that difference is exactly what the option is for:
 * a caller reading the example sees the cost of the guarantee they chose.
 */
function keyLiteral(names: Names, shape: Shape): (value: string) => string {
  return shape.branded
    ? (value: string): string => `${names.idFactory}("${value}")`
    : (value: string): string => `"${value}"`;
}

/**
 * The suite, which runs against `createMemoryStore` and therefore against the whole `Store` seam.
 *
 * What it is for is the part worth stating: it does not test that the emitted code compiles — the
 * generator already established that — it tests the claims the doc comments make. The tiebreaker makes
 * paging total, an update cannot move a record, a cursor into a deleted record does not silently
 * restart. Those are the properties a caller would otherwise have to discover in production.
 */
function tests(context: RenderContext, names: Names, shape: Shape): string {
  const coreSpec = siblingSpecifier(context.conventions, names.coreStem);
  const bindingSpec = siblingSpecifier(context.conventions, names.bindingStem);
  const it = names.instance;
  const key = keyLiteral(names, shape);
  const inlineBinding = shape.standalone;

  return sections(
    doc(
      `The ${names.entity} repository, exercised against the in-memory store.`,
      "Nothing here is mocked. The store is a real implementation of the seam a datastore adapter implements, so a failure means the repository is wrong rather than that a stub disagreed with it.",
    ),
    joinLines(
      frameworkImports(context.conventions),
      importsFrom(context.conventions, coreSpec, {
        values: [
          "DuplicateRecordError",
          "KeyChangedError",
          "RecordNotFoundError",
          "createMemoryStore",
          "gt",
          "not",
          "oneOf",
          ...(inlineBinding ? ["createRepository"] : []),
        ],
        types: inlineBinding ? ["CollectionSpec", "Repository", "Store"] : [],
      }),
      when(
        !inlineBinding,
        importsFrom(context.conventions, bindingSpec, {
          values: [names.factory, ...(shape.branded ? [names.idFactory] : [])],
          types: [names.recordType],
        }),
      ),
    ),
    when(
      inlineBinding,
      sections(
        doc(
          "The binding under test, which a full bundle would have as its own file.",
          "This scope emitted the machinery alone, so the suite declares the binding it exercises rather than importing one that is not there.",
        ),
        bindingBody(names, shape),
      ),
    ),
    documented(
      ["The domain type the suite stores, standing in for the caller's own."],
      dedent`
        interface Row extends ${names.recordType} {
          readonly status: "open" | "closed";
          readonly total: number;
        }
      `,
    ),
    documented(
      [
        "A fresh repository holding the same three records every time.",
        "Built per test rather than shared, because a suite whose tests can see each other's writes passes or fails according to the order they happen to run in.",
        'Inserted out of key order on purpose: "b" first, so a test asserting key order is asserting the ordering rather than the insertion sequence.',
      ],
      dedent`
      async function seeded(): Promise<ReturnType<typeof ${names.factory}<Row>>> {
        const ${it} = ${names.factory}<Row>(createMemoryStore());
        await ${it}.insertMany([
          { id: ${key("b")}, status: "open", total: 80 },
          { id: ${key("a")}, status: "open", total: 120 },
          { id: ${key("c")}, status: "closed", total: 20 },
        ]);
        return ${it};
      }
    `,
    ),
    describeBlock("reading", readingTests(names, shape)),
    describeBlock("filtering", filterTests(names, shape)),
    describeBlock("writing", writingTests(names, shape)),
    describeBlock(
      shape.pagination === "none" ? "listing" : "paging",
      listingTests(names, shape),
    ),
  );
}

function readingTests(names: Names, shape: Shape): string {
  const key = keyLiteral(names, shape);

  return joinLines(
    dedent`
      it("returns undefined for a key that is not there", async () => {
        const ${names.instance} = await seeded();
        expect(await ${names.instance}.get(${key("missing")})).toBeUndefined();
      });
    `,
    "",
    dedent`
      it("names what was missing when the caller said it must exist", async () => {
        const ${names.instance} = await seeded();
        await expect(${names.instance}.require(${key("missing")})).rejects.toBeInstanceOf(
          RecordNotFoundError,
        );
      });
    `,
    "",
    dedent`
      it("returns the records that exist and skips the keys that do not", async () => {
        const ${names.instance} = await seeded();
        const found = await ${names.instance}.getMany([${key("a")}, ${key("missing")}, ${key("c")}]);
        expect(found).toHaveLength(2);
      });
    `,
    "",
    dedent`
      it("reports existence without returning the record", async () => {
        const ${names.instance} = await seeded();
        expect(await ${names.instance}.exists(${key("a")})).toBe(true);
        expect(await ${names.instance}.exists(${key("missing")})).toBe(false);
      });
    `,
  );
}

function filterTests(names: Names, shape: Shape): string {
  const key = keyLiteral(names, shape);
  const items = shape.pagination === "none" ? "" : ".items";

  return joinLines(
    dedent`
      it("reads a bare value as equality", async () => {
        const ${names.instance} = await seeded();
        const open = await ${names.instance}.list({ where: { status: "open" } });
        expect(open${items}).toHaveLength(2);
      });
    `,
    "",
    dedent`
      it("compares rather than matches when given a comparison", async () => {
        const ${names.instance} = await seeded();
        expect(await ${names.instance}.count({ total: gt(50) })).toBe(2);
        expect(await ${names.instance}.count({ status: not("open") })).toBe(1);
        expect(await ${names.instance}.count({ id: oneOf([${key("a")}, ${key("c")}]) })).toBe(2);
      });
    `,
    "",
    dedent`
      it("counts the whole collection when no filter is given", async () => {
        const ${names.instance} = await seeded();
        expect(await ${names.instance}.count()).toBe(3);
      });
    `,
    "",
    dedent`
      it("finds the first match in key order, not insertion order", async () => {
        const ${names.instance} = await seeded();
        const first = await ${names.instance}.findOne({ status: "open" });
        // "b" was inserted first; "a" sorts first. The tiebreaker decides, which is what
        // makes this answer the same on every store.
        expect(first?.id).toBe(${key("a")});
      });
    `,
  );
}

function writingTests(names: Names, shape: Shape): string {
  const key = keyLiteral(names, shape);

  return joinLines(
    dedent`
      it("refuses to insert over a key that is taken", async () => {
        const ${names.instance} = await seeded();
        await expect(
          ${names.instance}.insert({ id: ${key("a")}, status: "closed", total: 1 }),
        ).rejects.toBeInstanceOf(DuplicateRecordError);
      });
    `,
    "",
    dedent`
      it("overwrites deliberately when asked to upsert", async () => {
        const ${names.instance} = await seeded();
        await ${names.instance}.upsert({ id: ${key("a")}, status: "closed", total: 1 });
        expect((await ${names.instance}.require(${key("a")})).total).toBe(1);
      });
    `,
    "",
    dedent`
      it("applies changes to the record as it stands", async () => {
        const ${names.instance} = await seeded();
        const updated = await ${names.instance}.update(${key("a")}, { total: 130 });
        // The untouched field survives, which is the difference between an update and a
        // write of whatever the caller happened to have in hand.
        expect(updated.status).toBe("open");
        expect(updated.total).toBe(130);
      });
    `,
    "",
    dedent`
      it("refuses an update that would move the record", async () => {
        const ${names.instance} = await seeded();
        await expect(
          ${names.instance}.update(${key("a")}, { id: ${key("z")} }),
        ).rejects.toBeInstanceOf(KeyChangedError);
        // Refused, not half-applied: the original is still where it was.
        expect(await ${names.instance}.exists(${key("a")})).toBe(true);
        expect(await ${names.instance}.exists(${key("z")})).toBe(false);
      });
    `,
    "",
    dedent`
      it("says whether a delete removed anything", async () => {
        const ${names.instance} = await seeded();
        expect(await ${names.instance}.delete(${key("a")})).toBe(true);
        expect(await ${names.instance}.delete(${key("a")})).toBe(false);
      });
    `,
  );
}

function listingTests(names: Names, shape: Shape): string {
  const key = keyLiteral(names, shape);
  const it = names.instance;

  if (shape.pagination === "none") {
    return joinLines(
      dedent`
        it("orders by the key when nothing else is asked for", async () => {
          const ${it} = await seeded();
          const all = await ${it}.list();
          expect(all.map((row) => row.id)).toEqual([${key("a")}, ${key("b")}, ${key("c")}]);
        });
      `,
      "",
      dedent`
        it("breaks a tie by key rather than arbitrarily", async () => {
          const ${it} = await seeded();
          // Two records share a status, so the requested sort does not determine an order.
          const open = await ${it}.list({
            where: { status: "open" },
            sort: [{ field: "status", direction: "asc" }],
          });
          expect(open.map((row) => row.id)).toEqual([${key("a")}, ${key("b")}]);
        });
      `,
    );
  }

  // "Carry on from the page I am holding", in each dialect. Spelled from the page rather than as a
  // literal because the literal has to agree with `limit` and silently does not when it stops:
  // `offset: 1` after a two-record page re-reads the second record, which is how this suite spent a
  // while asserting `[a, b, b, c]` was `[a, b, c]`.
  const window =
    shape.pagination === "cursor" ? "after: first.cursor" : "offset: first.items.length";

  return joinLines(
    dedent`
      it("orders by the key when nothing else is asked for", async () => {
        const ${it} = await seeded();
        const page = await ${it}.list();
        expect(page.items.map((row) => row.id)).toEqual([${key("a")}, ${key("b")}, ${key("c")}]);
      });
    `,
    "",
    dedent`
      it("returns each record exactly once across consecutive pages", async () => {
        const ${it} = await seeded();
        const first = await ${it}.list({ limit: 2 });
        const rest = await ${it}.list({ limit: 2, ${window} });
        expect(first.items).toHaveLength(2);
        // Three records, two pages, no record on both: the tiebreaker is what guarantees this.
        expect([...first.items, ...rest.items].map((row) => row.id)).toEqual([
          ${key("a")},
          ${key("b")},
          ${key("c")},
        ]);
      });
    `,
    "",
    dedent`
      it("reports whether anything follows the page", async () => {
        const ${it} = await seeded();
        expect((await ${it}.list({ limit: 2 })).hasMore).toBe(true);
        expect((await ${it}.list({ limit: 10 })).hasMore).toBe(false);
      });
    `,
    "",
    when(
      shape.pagination === "cursor",
      dedent`
        it("stops rather than restarting when the cursor names a deleted record", async () => {
          const ${it} = await seeded();
          const first = await ${it}.list({ limit: 1 });
          await ${it}.delete(${key("a")});
          const rest = await ${it}.list({ limit: 1, after: first.cursor });
          // Restarting here would hand the caller the first page a second time, which is
          // worse than returning nothing: they would never notice.
          expect(rest.items).toHaveLength(0);
        });
      `,
    ),
    when(
      shape.pagination === "offset",
      dedent`
        it("reports the matching total, not the page size", async () => {
          const ${it} = await seeded();
          const page = await ${it}.list({ where: { status: "open" }, limit: 1 });
          expect(page.items).toHaveLength(1);
          expect(page.total).toBe(2);
        });
      `,
    ),
  );
}

function describeBlock(name: string, body: string): string {
  return dedent`
    describe("${name}", () => {
      ${body}
    });
  `;
}

/**
 * Every name the emitted files use, derived once.
 *
 * Derived here rather than at each use site because the binding, the example, and the suite all have
 * to agree: a factory the example imports under one name and the binding exports under another is a
 * bundle that does not compile, and that is the kind of mistake a template makes when two functions
 * each spell a name out.
 */
function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;

  if (entity === undefined) {
    return {
      coreStem: CORE_STEM,
      bindingStem: "entity-repository",
      entity: "Entity",
      sampleType: "Entity",
      renamedSample: false,
      collection: "entities",
      idType: "EntityId",
      idFactory: "entityId",
      recordType: "EntityRecord",
      factory: "createEntityRepository",
      instance: "entities",
      exampleFn: "openEntities",
      specConst: "ENTITIES",
    };
  }

  // The plural, because a collection holds many. This is why identifier validation refuses words
  // whose plural English cannot agree on: `status` would give either `statuses` or `stati`, and a
  // silent coin-flip would decide a table name.
  const plural = entity.pluralStem.replaceAll("-", "_");

  const id = withNoun(entity, "Id");
  const repository = withNoun(entity, "Repository");
  const recordType = withNoun(entity, "Record").pascal;

  // `AuditRecord` derives the record type `AuditRecord`, so the example's own domain type — the one
  // standing in for the caller's — has to give way rather than be declared twice (FR-052).
  const sampleType = standIn(entity.pascal, [recordType, id.pascal, "Row", ...DECLARED]);

  return {
    coreStem: CORE_STEM,
    bindingStem: repository.kebab,
    entity: entity.pascal,
    sampleType,
    renamedSample: sampleType !== entity.pascal,
    collection: plural,
    idType: id.pascal,
    idFactory: id.camel,
    recordType,
    factory: `create${repository.pascal}`,
    instance: camelOf(entity.pluralStem),
    exampleFn: `open${pascalOf(entity.pluralStem)}`,
    specConst: plural.toUpperCase(),
  };
}

function camelOf(stem: string): string {
  const [first = "", ...rest] = stem.split("-");
  return first + rest.map((word) => pascalOf(word)).join("");
}

function pascalOf(stem: string): string {
  return stem
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}
