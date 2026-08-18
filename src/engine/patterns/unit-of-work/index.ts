/**
 * The `unit-of-work` pattern: every change a transaction makes, accumulated and then written once.
 *
 * The second pattern here that splits, and it splits along the same seam as `repository` for the same
 * reason. The *core* is the change tracking, the store seam, and an in-memory store — none of which
 * mentions a domain type. The *binding* is one entity's minimum record, its collection name, and a typed
 * accessor over a unit of work. Eleven entities want one core and eleven bindings (FR-017).
 *
 * Three decisions inside the emitted code are worth reading twice.
 *
 * **The store seam takes a batch, not a transaction.** `apply(operations)` hands the adapter the whole
 * change set at once instead of `transaction(fn)` handing it a connection to thread through every read
 * and write. That makes the seam implementable on a store with no interactive transaction — one bulk
 * write, one request — and it keeps the unit of work from holding a connection open while domain code
 * runs. The price is stated rather than hidden: reads happen before the commit, so they are outside it,
 * which is exactly why `concurrency: "version"` exists.
 *
 * **The key field's *name* is a type parameter, and the entity is constrained rather than the field.**
 * `T extends Storable<F>`, where `Storable<F>` is `Readonly<Record<F, string>>`, is what makes
 * `record[spec.keyField]` an ordinary indexed access rather than a cast, and what makes
 * `Partial<Omit<T, F>>` a patch type that refuses to change a record's identity. The obvious spelling —
 * a filtered `keyof T` — names the right fields and leaves `T[F]` unreducible, so reading the key would
 * need an assertion the constraint form does not.
 *
 * **A spec carries a phantom property in its entity.** Without it, two collections keyed on a field of
 * the same name are the same type, and a function annotated for one accepts the other's spec — handing
 * back records of the wrong type with no diagnostic anywhere.
 *
 * What could not be done is worth recording too. The region trick that would keep two open units of
 * work's tracked records apart does not work here: the scope parameter is inferred at the call site, so
 * two nested scopes receive the same one and their records interchange freely. Refusing to use a
 * committed unit of work is therefore a run-time check, which is what `typestate` says about any
 * lifecycle whose value escapes into a closure.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { standIn, withNoun } from "../../options/names.js";
import { dedent, doc, docAt, documented, joinLines, sections, when } from "../../render/helpers.js";
import { expectFileEntry, frameworkImports } from "../expect-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

interface Shape {
  /** `tracking: "snapshot"` — a mutable draft compared against a copy, rather than an `update` method. */
  readonly snapshot: boolean;
  /** `concurrency: "version"` — every record carries a version and every write checks it. */
  readonly versioned: boolean;
  /**
   * `emitScope: "core-only"` — there is no binding file, so the example and the suite declare the
   * collection they demonstrate instead of importing one this scope does not emit.
   */
  readonly standalone: boolean;
}

interface Names {
  /** Entity-independent by definition: it is the file every binding imports. */
  readonly coreStem: string;
  readonly bindingStem: string;
  readonly entity: string;
  /**
   * The name the example and the suite give their stand-in for the caller's type, which is the
   * caller's own name except when the machinery has already taken it.
   *
   * Both files declare a domain type to have something to track, and both import the core's exports
   * to do the tracking with. `Store` is one of those exports and also an ordinary thing to call a
   * domain type, so a caller who asked for it received `interface Store` in a module that imports
   * `Store` — an answer refused as a defect in the pattern, over a name we chose and they could not
   * see. Distinct from `entity`, which still names the caller's type wherever a comment is talking
   * about their code rather than declaring ours.
   */
  readonly sampleType: string;
  /** Whether `sampleType` had to step aside, so the example can say why it is not called what you asked. */
  readonly renamedSample: boolean;
  readonly collection: string;
  readonly recordType: string;
  readonly accessType: string;
  /** The binding's factory, and how a caller reads it: `orders(uow)`. */
  readonly accessor: string;
  /** The exported spec builder: `orderCollectionSpec<Order>()`. */
  readonly specFactory: string;
  readonly collectionConst: string;
  /** The example's entry point, named after the transaction it performs. */
  readonly exampleFn: string;
}

export const CORE_STEM = "unit-of-work-core";

/**
 * Every name this pattern writes literally, in any file it can emit.
 *
 * The example and the suite declare a type of the caller's choosing beside these, so a name that
 * appears in both places is declared twice in one module. Listing them lets the stand-in step aside
 * instead, which is the difference between `Store` being usable and `Store` being refused.
 *
 * `conformance/emitted-names` reads the real names out of a rendered bundle, so an addition that is
 * missed here is reported rather than discovered by whoever asks for it first.
 */
const DECLARED: readonly string[] = [
  "AlreadyStoredError",
  "AlreadyTrackedError",
  "CollectionSpec",
  "ConcurrencyError",
  "Draft",
  "MemoryStore",
  "NewRecord",
  "RecordNotFoundError",
  "RemovedRecordError",
  "Store",
  "Tracked",
  "UnitOfWork",
  "UnitOfWorkClosedError",
];

export const unitOfWorkPattern: PatternModule = {
  name: "unit-of-work",

  /**
   * The core's type for a record that has not been stored yet. An entity of `NewRecord` derives the
   * binding's record type as the same name by collapse, and that one is exported for the caller to build
   * against, so it cannot step aside the way the example's stand-in does.
   *
   * `KeyChangedError` is thrown under `tracking=snapshot` when a draft's key moved, so it is a name the
   * caller writes a `catch` against. It only exists in that branch, which is how the first sweep of this
   * class missed it: it read one render at the defaults.
   */
  emits: ["KeyChangedError", "NewRecord"],

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      snapshot: options.tracking === "snapshot",
      versioned: options.concurrency !== "none",
      standalone: options.emitScope === "core-only",
    };
    const names = namesFor(context);

    // Named after whichever half the file demonstrates, so a `core-only` caller's example is not named
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

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;

  if (entity === undefined) {
    return {
      coreStem: CORE_STEM,
      bindingStem: "entity-collection",
      entity: "Entity",
      sampleType: "Entity",
      renamedSample: false,
      collection: "entities",
      recordType: "EntityRecord",
      accessType: "EntityTracking",
      accessor: "entities",
      specFactory: "entityCollectionSpec",
      collectionConst: "ENTITIES_COLLECTION",
      exampleFn: "settleEntities",
    };
  }

  // The plural, because a collection holds many. Identifier validation has already refused words whose
  // English plural is contested, so this is one documented form rather than a coin-flip.
  const plural = entity.pluralStem.replaceAll("-", "_");

  const recordType = withNoun(entity, "Record").pascal;
  const accessType = withNoun(entity, "Tracking").pascal;

  // The derived names belong in here as well as the fixed ones: `AuditRecord` derives the record type
  // `AuditRecord`, so the name in the stand-in's way came from the caller by way of the collapse.
  const sampleType = standIn(entity.pascal, [...DECLARED, recordType, accessType]);

  return {
    coreStem: CORE_STEM,
    bindingStem: `${entity.stem}-collection`,
    entity: entity.pascal,
    sampleType,
    renamedSample: sampleType !== entity.pascal,
    collection: plural,
    recordType,
    accessType,
    accessor: camelOf(entity.pluralStem),
    specFactory: `${camelOf(entity.stem)}CollectionSpec`,
    collectionConst: `${plural.toUpperCase()}_COLLECTION`,
    exampleFn: `settle${pascalOf(entity.pluralStem)}`,
  };
}

function camelOf(stem: string): string {
  const [first, ...rest] = stem.split("-");
  return [first ?? "", ...rest.map(capitalize)].join("");
}

function pascalOf(stem: string): string {
  return stem.split("-").map(capitalize).join("");
}

function capitalize(word: string): string {
  return word === "" ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

// ---------------------------------------------------------------------------------------------------
// The core: everything that does not mention a domain type.
// ---------------------------------------------------------------------------------------------------

function core(shape: Shape): string {
  return sections(
    coreHeader(shape),
    fieldsType(),
    storableTypes(shape),
    specType(),
    changeTypes(shape),
    trackedType(shape),
    operationType(shape),
    storeType(),
    errorClasses(shape),
    registrationType(shape),
    unitOfWorkClass(shape),
    operationForFunction(shape),
    comparisonHelpers(shape),
    slotFunction(),
    withUnitOfWorkFunction(),
    storeErrorClass(),
    memoryStore(shape),
  );
}

function coreHeader(shape: Shape): string {
  const tracking = shape.snapshot
    ? "Changes are noticed by comparison. Each tracked record hands back a mutable draft, and a copy of what was loaded is kept beside it; at commit the two are compared field by field and only a record that actually differs is written. Nothing has to be declared, which is what lets a draft be handed to domain code that knows nothing about persistence."
    : "Changes are declared. Each tracked record has an `update` method taking a patch, so a change cannot be missed and nothing is copied. The patch type excludes the key field, which makes changing a record's identity a compile error rather than a surprise at commit.";

  const concurrency = shape.versioned
    ? "Every record carries a `version`, and every write is conditional on the value that was loaded. If another unit of work got there first the whole commit fails, with the record named, and nothing is written. Some such check is the only defence available: reads happen before the commit, so they are not inside it."
    : 'Writes are unconditional, so the last commit wins. Two units of work that loaded the same record will not conflict — the second silently overwrites the first. That is fine where each record has one writer, and a lost update everywhere else, which is what `concurrency: "version"` is for.';

  return doc(
    "A unit of work: changes accumulate here and are written in one commit.",
    "Nothing here mentions a domain type. This module is the machinery every entity shares; each entity gets a small binding of its own that supplies its record constraint and collection name.",
    tracking,
    concurrency,
    "`Store` is the seam, and it takes a *batch* rather than handing out a transaction. That is what makes it implementable on a datastore with no interactive transaction, and it keeps a connection from being held open while domain code runs. Applying a batch atomically is the adapter's half of the contract; `createMemoryStore` is a complete implementation that honours it.",
    "There is no `rollback`, because there is nothing to roll back: nothing has been written before `commit`, so abandoning a unit of work is how a transaction is discarded.",
  );
}

function fieldsType(): string {
  return documented(
    [
      "A record as this module holds it: fields by name, its type forgotten.",
      "One table holds the records of every collection, and a table keyed by strings cannot know that `orders` holds orders. So the type is dropped here and asserted again where a record is handed back — two halves of one unsoundness, in two named places, rather than scattered through the file.",
    ],
    dedent`
      export type Fields = Readonly<Record<string, unknown>>;

      function fieldsOf(record: object): Fields {
        return record as Fields;
      }
    `,
  );
}

function storableTypes(shape: Shape): string {
  const versioned = when(
    shape.versioned,
    documented(
      [
        "What a versioned record carries beyond its key.",
        "This module owns the field: it is assigned on insert, incremented on update, and set from what was stored when a commit succeeds. A value a caller writes to it does not survive.",
      ],
      dedent`
        export interface Versioned {
          readonly version: number;
        }
      `,
    ),
  );

  return sections(
    versioned,
    documented(
      [
        "The least a record must be for this module to track it: a string-valued field holding its key.",
        "Constraining the record rather than the field is what keeps this file free of casts. `keyof T` filtered to its string-valued members names the right fields and leaves `T[F]` unreducible, so reading a key would need an assertion; written this way, `record[spec.keyField]` is an ordinary indexed access.",
      ],
      shape.versioned
        ? "export type Storable<F extends string> = Readonly<Record<F, string>> & Versioned;"
        : "export type Storable<F extends string> = Readonly<Record<F, string>>;",
    ),
  );
}

function specType(): string {
  return documented(
    [
      "What a binding tells this module about one collection.",
      "`keyField` is the field's *name*, as a type parameter, which is what lets a patch type exclude it and a key be read without a cast.",
      "Keys are strings because a record must have its key before it is inserted: the identity map is keyed on it, and a key the datastore assigns is not known until after the write, by which time nothing in the same transaction could have referred to the new record. A sequence-assigned integer key therefore cannot participate, and saying so is better than appearing to support it.",
    ],
    dedent`
      declare const ENTITY: unique symbol;

      export interface CollectionSpec<T extends Storable<F>, F extends string> {
        readonly collection: string;
        readonly keyField: F;
        ${docAt(2, "Phantom: never read, never written, never present at run time. Without it, two collections keyed on a field of the same name are the same type, so a function annotated for one would accept the other's spec and hand back records of the wrong type.")}
        readonly [ENTITY]?: T;
      }
    `,
  );
}

function changeTypes(shape: Shape): string {
  if (shape.snapshot) {
    return documented(
      [
        "A tracked record as the caller changes it: the loaded fields, with `readonly` removed.",
        'Shallow, which is what the comparison at commit is too. Replacing a nested object counts as a change; reaching into one and mutating it does not, because the draft and the copy taken at load hold the same reference. `tracking: "explicit"` is the rendering with no such rule.',
      ],
      "export type Draft<T> = { -readonly [K in keyof T]: T[K] };",
    );
  }

  const omitted = `F${when(shape.versioned, ' | "version"')}`;

  return sections(
    documented(
      [
        "The fields of a tracked record that may be changed.",
        `The key field is absent, so changing a record's identity is a compile error. It has to be: applying it would mean either a second record under the new key or a silent delete of the old one, and neither is what the line said.${when(shape.versioned, " `version` is absent for the reason given above — this module owns it.")}`,
        "Written out rather than as `Partial<Omit<…>>` so that every field admits an explicit `undefined`, which `Partial` alone does not under `exactOptionalPropertyTypes`. A caller spreading a form or a partial DTO produces exactly that, and `update` is documented to treat it as no change — so it has to be sayable, or the same code would compile under one configuration and not another.",
      ],
      dedent`
        export type Patch<T, F extends string> = {
          [K in keyof Omit<T, ${omitted}>]?: T[K] | undefined;
        };
      `,
    ),
  );
}

function trackedType(shape: Shape): string {
  const removeDoc = docAt(
    2,
    "Mark this record for deletion. Idempotent, and a record added in this unit of work leaves the plan entirely rather than becoming an insert followed by a delete of something never written.",
  );

  const members = shape.snapshot
    ? joinLines(
        docAt(2, "The record as it stands, mutable. Change it in place; what differs is worked out at commit."),
        "  readonly draft: Draft<T>;",
        removeDoc,
        "  remove(): void;",
      )
    : joinLines(
        docAt(2, "The record as it stands, including every change made through `update`."),
        "  readonly value: T;",
        docAt(2, "Record a change. Merging rather than replacing, so two callers each changing one field do not undo each other. An `undefined` value is not a change and does not erase the field: erasing one has to be said in the domain type, with a `null` or an absent-marker of its own, because a patch cannot tell \"leave it alone\" from \"clear it\"."),
        "  update(changes: Patch<T, F>): void;",
        removeDoc,
        "  remove(): void;",
      );

  return sections(
    when(
      shape.versioned,
      documented(
        [
          "A record on its way in, before this module has given it a version.",
          "The intersection restates the key requirement because `Omit` leaves the compiler unable to see it: `F` is a bare `string` there, so as far as the type system knows it could name the field just removed.",
        ],
        'export type NewRecord<T, F extends string> = Omit<T, "version"> & Readonly<Record<F, string>>;',
      ),
    ),
    documented(
      [
        "A record this unit of work is watching.",
        "A plain record is not one of these, which is the point: a function that means to change something persistently can say so in its parameter type, and be handed a record nobody is watching only over a compile error.",
      ],
      dedent`
        export interface Tracked<T extends Storable<F>, F extends string> {
        ${members}
        }
      `,
    ),
  );
}

function operationType(shape: Shape): string {
  const expected = when(
    shape.versioned,
    joinLines(
      docAt(6, "The version the record held when it was loaded. The write must not happen if the stored value has moved."),
      "      readonly expectedVersion: number;",
    ),
  );

  return documented(
    [
      "One write, as the store receives it.",
      "Insert, update and delete rather than one upsert, because the three have different failure conditions and an adapter that cannot tell them apart cannot report which one it was: an insert onto an occupied key and a delete of a key that has gone are both mistakes, and an upsert hides them both.",
    ],
    dedent`
      export type Operation =
        | {
            readonly kind: "insert";
            readonly collection: string;
            readonly key: string;
            readonly record: Fields;
          }
        | {
      ${joinLines(
        '      readonly kind: "update";',
        "      readonly collection: string;",
        "      readonly key: string;",
        "      readonly record: Fields;",
        expected,
      )}
          }
        | {
      ${joinLines(
        '      readonly kind: "delete";',
        "      readonly collection: string;",
        "      readonly key: string;",
        expected,
      )}
          };
    `,
  );
}

function storeType(): string {
  return documented(
    [
      "The datastore seam: implement once per datastore, share across every unit of work.",
      "`read` is generic in the record type, which means the implementation is trusted to return the shape the collection holds — the unsoundness every persistence boundary has, confined here on purpose.",
      "`apply` receives the whole batch and must apply all of it or none of it. That is the contract, and it is the one this pattern rests on: a half-applied commit is the failure a unit of work exists to prevent, and no amount of care above this line can prevent it if the line below does not hold.",
    ],
    dedent`
      export interface Store {
        read<T>(collection: string, key: string): Promise<T | undefined>;
        apply(batch: readonly Operation[]): Promise<void>;
      }
    `,
  );
}

function keyedError(name: string, message: string, docs: readonly string[]): string {
  return documented(
    docs,
    dedent`
      export class ${name} extends Error {
        readonly collection: string;
        readonly key: string;

        constructor(collection: string, key: string) {
          super(${message});
          this.name = "${name}";
          this.collection = collection;
          this.key = key;
        }
      }
    `,
  );
}

function errorClasses(shape: Shape): string {
  return sections(
    keyedError("RecordNotFoundError", '`No record in "${collection}" with key "${key}".`', [
      "A record that had to exist did not.",
      "Thrown by `require` and not by `load`: a lookup that may legitimately find nothing returns `undefined`, and one whose caller has already decided the record must be there gets an error naming what was missing.",
    ]),
    keyedError(
      "AlreadyTrackedError",
      '`"${key}" in "${collection}" is already tracked by this unit of work.`',
      [
        "`add` was given a key this unit of work is already watching.",
        "Refused rather than merged, because the two plausible meanings differ: adding a record that was loaded is an update written as an insert, and adding one twice is a duplicate. Neither is worth guessing at.",
      ],
    ),
    when(
      !shape.snapshot,
      keyedError(
        "RemovedRecordError",
        '`"${key}" in "${collection}" was removed in this unit of work, so it cannot be updated.`',
        [
          "A record was changed after being marked for deletion.",
          "Refused, because no order of the two operations does what the code appears to say: the delete either discards the change or resurrects the record.",
        ],
      ),
    ),
    when(
      shape.snapshot,
      keyedError(
        "KeyChangedError",
        '`"${key}" in "${collection}" had its key changed, which describes a different record.`',
        [
          "A draft's key field was changed before commit.",
          "Caught here rather than in the type, because a draft is a plain mutable object: `readonly` on its key would refuse a direct assignment and nothing else, since TypeScript does not check `readonly` when a value is passed to a function. One rule that always holds is worth more than one and a half.",
        ],
      ),
    ),
    when(
      shape.versioned,
      keyedError("ConcurrencyError", '`Record "${key}" in "${collection}" changed since it was loaded.`', [
        "Another writer got there first.",
        "Thrown by the store while applying a batch, and exported so that every adapter reports a conflict the same way. Nothing in the batch has been written when this arrives, which is what makes retrying the whole transaction the right response to it.",
      ]),
    ),
    documented(
      [
        "The unit of work has already been committed.",
        "Every method refuses rather than proceeding, because the alternative is a change that is silently never written — indistinguishable from success until the record is read back somewhere else. A committed unit of work is finished; open another.",
      ],
      dedent`
        export class UnitOfWorkClosedError extends Error {
          constructor(action: string) {
            super(
              \`This unit of work has been committed, so \${action} would never be written. \` +
                "Open another for the next transaction.",
            );
            this.name = "UnitOfWorkClosedError";
          }
        }
      `,
    ),
  );
}

function registrationType(shape: Shape): string {
  const fields = joinLines(
    "  readonly collection: string;",
    "  readonly keyField: string;",
    "  readonly key: string;",
    '  state: "new" | "loaded" | "removed";',
    shape.snapshot
      ? joinLines(
          "  draft: Record<string, unknown>;",
          docAt(2, "The fields as they were when this record was loaded. Shares nested references with the draft, which is what makes the comparison shallow by construction."),
          "  loaded: Fields;",
        )
      : joinLines("  record: Fields;", "  changed: boolean;"),
    when(shape.versioned, "  loadedVersion: number;"),
    docAt(2, "Handed back on every later load of the same key, so two parts of one transaction cannot hold different copies of one record."),
    "  handle: unknown;",
  );

  return dedent`
    /** One record this unit of work is watching, as it is held internally. */
    interface Registration {
    ${fields}
    }
  `;
}

function unitOfWorkClass(shape: Shape): string {
  return documented(
    [
      "Changes accumulate here; `commit` writes them.",
      "One instance per business transaction. It is not a cache: the identity map exists so that two parts of one transaction agree with each other, and holding one open across transactions would mean serving records loaded arbitrarily long ago.",
    ],
    dedent`
      export class UnitOfWork {
        private readonly registrations = new Map<string, Registration>();
        private readonly sequence: Registration[] = [];
        private closed = false;

        constructor(private readonly store: Store) {}

        ${loadMethod(shape)}

        ${requireMethod()}

        ${addMethod(shape)}

        ${planMethod()}

        ${commitMethod(shape)}

        ${registerMethod()}

        ${handleForMethod(shape)}

        ${plannedMethod(shape)}

        private assertOpen(action: string): void {
          if (this.closed) {
            throw new UnitOfWorkClosedError(action);
          }
        }
      }
    `,
  );
}

function loadMethod(shape: Shape): string {
  const registration = joinLines(
    "          collection: spec.collection,",
    "          keyField: spec.keyField,",
    "          key,",
    '          state: "loaded",',
    shape.snapshot
      ? joinLines("          draft: { ...fieldsOf(record) },", "          loaded: fieldsOf(record),")
      : joinLines("          record: fieldsOf(record),", "          changed: false,"),
    when(shape.versioned, "          loadedVersion: record.version,"),
    "          handle: undefined,",
  );

  return documented(
    [
      "The record under this key, tracked, or `undefined` if there is none.",
      "A record this unit of work has already loaded or added comes back without the store being touched, and one it has removed reads as absent — so a transaction sees its own changes, which is the difference between a unit of work and a series of unrelated calls.",
    ],
    dedent`
      async load<T extends Storable<F>, F extends string>(
        spec: CollectionSpec<T, F>,
        key: T[F],
      ): Promise<Tracked<T, F> | undefined> {
        this.assertOpen("loading a record");

        const known = this.registrations.get(slotFor(spec.collection, key));
        if (known !== undefined) {
          return known.state === "removed" ? undefined : this.handleFor<T, F>(known);
        }

        const record = await this.store.read<T>(spec.collection, key);
        if (record === undefined) {
          return undefined;
        }

        return this.handleFor<T, F>(
          this.register({
      ${registration}
          }),
        );
      }
    `,
  );
}

function requireMethod(): string {
  return documented(
    [
      "The record under this key, tracked, or an error naming what was missing.",
      "@throws RecordNotFoundError when there is no such record.",
    ],
    dedent`
      async require<T extends Storable<F>, F extends string>(
        spec: CollectionSpec<T, F>,
        key: T[F],
      ): Promise<Tracked<T, F>> {
        const found = await this.load<T, F>(spec, key);
        if (found === undefined) {
          throw new RecordNotFoundError(spec.collection, key);
        }
        return found;
      }
    `,
  );
}

function addMethod(shape: Shape): string {
  const stored = shape.versioned ? "{ ...fieldsOf(record), version: 1 }" : "{ ...fieldsOf(record) }";

  const registration = joinLines(
    "          collection: spec.collection,",
    "          keyField: spec.keyField,",
    "          key,",
    '          state: "new",',
    shape.snapshot
      ? joinLines(`          draft: ${stored},`, "          loaded: {},")
      : joinLines(`          record: ${stored},`, "          changed: true,"),
    when(shape.versioned, "          loadedVersion: 0,"),
    "          handle: undefined,",
  );

  return documented(
    [
      "Track a new record, to be inserted at commit.",
      `A copy is taken, so the handle is what to change from here${when(shape.snapshot, " — its `draft`, not the object that was passed in")}.${when(shape.versioned, " The version is assigned rather than supplied, which is why the parameter type has no `version` field.")}`,
      "@throws AlreadyTrackedError when this unit of work is already watching that key.",
    ],
    dedent`
      add<T extends Storable<F>, F extends string>(
        spec: CollectionSpec<T, F>,
        record: ${shape.versioned ? "NewRecord<T, F>" : "T"},
      ): Tracked<T, F> {
        this.assertOpen("adding a record");

        const key = record[spec.keyField];
        if (this.registrations.has(slotFor(spec.collection, key))) {
          throw new AlreadyTrackedError(spec.collection, key);
        }

        return this.handleFor<T, F>(
          this.register({
      ${registration}
          }),
        );
      }
    `,
  );
}

function planMethod(): string {
  return documented(
    [
      "What `commit` would write, in the order it would write it.",
      'Public because it is the honest answer to "is there anything to do": an empty plan means no write, which is not the same as no changes having been attempted. A transaction worth logging is also worth logging as the operations it became.',
    ],
    dedent`
      plan(): readonly Operation[] {
        return this.planned().map((entry) => entry.operation);
      }
    `,
  );
}

function plannedMethod(shape: Shape): string {
  const keyCheck = when(
    shape.snapshot,
    joinLines(
      "    // Before anything is planned, because a moved key makes every operation below describe a record",
      "    // other than the one that was loaded. Here rather than in `commit` so that `plan` refuses it too:",
      "    // a plan that reported a write under the old key would be a plan nobody could act on.",
      "    for (const registration of this.sequence) {",
      "      assertKeyIntact(registration);",
      "    }",
      "",
    ),
  );

  return documented(
    [
      "Each pending write beside the record it came from.",
      "Inserts, then updates, then deletes; registration order within each. A row an update refers to therefore exists before the update, and a row still referred to is not deleted first. Order between collections is registration order and nothing cleverer — a true dependency order would need to know which fields are references, which nothing here is told.",
    ],
    dedent`
      private planned(): readonly { registration: Registration; operation: Operation }[] {
      ${keyCheck}
        const planned: { registration: Registration; operation: Operation }[] = [];

        for (const kind of ["insert", "update", "delete"] as const) {
          for (const registration of this.sequence) {
            const operation = operationFor(registration);
            if (operation !== undefined && operation.kind === kind) {
              planned.push({ registration, operation });
            }
          }
        }

        return planned;
      }
    `,
  );
}

function commitMethod(shape: Shape): string {
  const writeBack = when(
    shape.versioned,
    dedent`
      // What was stored, written back, so that a record still in the caller's hands carries the version
      // of the row it describes rather than the one it was loaded at.
      //
      // Only the record. \`loadedVersion\` is bookkeeping for the next write, and there is no next write:
      // this unit of work is finished below, and nothing that reads that field can be reached again.
      for (const { registration, operation } of planned) {
        if (operation.kind !== "delete") {
      ${when(shape.snapshot, "      registration.draft = { ...operation.record };", "      registration.record = operation.record;")}
        }
      }
    `,
  );

  const settle = joinLines(
    "    // Nothing is pending any more, which `plan()` should say: a record that was inserted is a loaded",
    "    // one now, a record that was deleted is gone, and a change that has been written is not a change.",
    "    for (const registration of [...this.sequence]) {",
    '      if (registration.state === "removed") {',
    "        this.registrations.delete(slotFor(registration.collection, registration.key));",
    "        this.sequence.splice(this.sequence.indexOf(registration), 1);",
    "        continue;",
    "      }",
    "",
    '      registration.state = "loaded";',
    when(shape.snapshot, "      registration.loaded = { ...registration.draft };", "      registration.changed = false;"),
    "    }",
  );

  const throws = joinLines(
    when(
      shape.versioned,
      "@throws ConcurrencyError by way of the store, when a record has changed since it was loaded.",
    ),
    when(shape.snapshot, "@throws KeyChangedError when a draft's key field was changed."),
    "@throws UnitOfWorkClosedError when this unit of work has already been committed.",
  );

  return documented(
    [
      "Write every accumulated change, or none of them.",
      "The unit of work is closed afterwards and every method on it refuses. A commit that *fails* leaves it open: nothing was written, so the caller can look at what happened and decide whether to try again.",
      throws,
    ],
    dedent`
      async commit(): Promise<void> {
        this.assertOpen("committing");

        const planned = this.planned();

        if (planned.length > 0) {
          await this.store.apply(planned.map((entry) => entry.operation));
        }
      ${when(writeBack !== "", `\n  ${writeBack}\n`)}
        this.closed = true;
      ${settle}
      }
    `,
  );
}

function registerMethod(): string {
  return dedent`
    private register(registration: Registration): Registration {
      this.registrations.set(slotFor(registration.collection, registration.key), registration);
      this.sequence.push(registration);
      return registration;
    }
  `;
}

function handleForMethod(shape: Shape): string {
  const accessor = shape.snapshot
    ? dedent`
        get draft(): Draft<T> {
          return registration.draft as unknown as Draft<T>;
        },
      `
    : dedent`
        get value(): T {
          return registration.record as unknown as T;
        },
      `;

  const update = when(
    !shape.snapshot,
    dedent`
      update: (changes: Patch<T, F>): void => {
        this.assertOpen("updating a record");
        if (registration.state === "removed") {
          throw new RemovedRecordError(registration.collection, registration.key);
        }

        const supplied = Object.entries(changes).filter(([, value]) => value !== undefined);
        if (supplied.length === 0) {
          return;
        }

        registration.record = { ...registration.record, ...Object.fromEntries(supplied) };
        registration.changed = true;
      },
    `,
  );

  return documented(
    [
      "The handle for a registration, made once and then kept.",
      "The one place a record's type is asserted rather than proven, and the other half of `fieldsOf`. What is trusted is that a collection name names one entity type, which the phantom on `CollectionSpec` is what makes hard to get wrong: a spec for one entity cannot be passed where another's is expected.",
      "Kept rather than remade because identity is part of what this pattern promises — two loads of one key are the same handle, so a change made through one is visible through the other.",
    ],
    dedent`
      private handleFor<T extends Storable<F>, F extends string>(
        registration: Registration,
      ): Tracked<T, F> {
        const existing = registration.handle;
        if (existing !== undefined) {
          return existing as Tracked<T, F>;
        }

        const handle: Tracked<T, F> = {
          ${accessor}
      ${when(update !== "", `    ${update}`)}
          remove: (): void => {
            this.assertOpen("removing a record");

            // A record added in this unit of work has never been written, so there is nothing to delete:
            // it leaves the plan entirely rather than becoming an insert followed by a delete.
            if (registration.state === "new") {
              this.registrations.delete(slotFor(registration.collection, registration.key));
              const at = this.sequence.indexOf(registration);
              if (at >= 0) {
                this.sequence.splice(at, 1);
              }
            }

            registration.state = "removed";
          },
        };

        registration.handle = handle;
        return handle;
      }
    `,
  );
}

function operationForFunction(shape: Shape): string {
  const unchanged = shape.snapshot
    ? "if (changedFields(registration).length === 0) {"
    : "if (!registration.changed) {";

  const current = shape.snapshot ? "{ ...registration.draft }" : "registration.record";

  const updateRecord = shape.versioned
    ? joinLines(
        `        record: { ...registration.${shape.snapshot ? "draft" : "record"}, version: registration.loadedVersion + 1 },`,
        "        expectedVersion: registration.loadedVersion,",
      )
    : `        record: ${current},`;

  return documented(
    [
      "The single write a tracked record has become, or nothing.",
      "This is where the states collapse, and where the reason for collapsing them shows: a record that was loaded and not changed produces *no* write. A unit of work that wrote back everything it had seen would be slower and, worse, would conflict with every other transaction that had merely read the same record.",
    ],
    dedent`
      function operationFor(registration: Registration): Operation | undefined {
        switch (registration.state) {
          case "new":
            return {
              kind: "insert",
              collection: registration.collection,
              key: registration.key,
              record: ${current},
            };

          case "loaded": {
            ${unchanged}
              return undefined;
            }

            return {
              kind: "update",
              collection: registration.collection,
              key: registration.key,
      ${updateRecord}
            };
          }

          case "removed":
            return {
              kind: "delete",
              collection: registration.collection,
              key: registration.key,
      ${when(shape.versioned, "        expectedVersion: registration.loadedVersion,")}
            };
        }
      }
    `,
  );
}

function comparisonHelpers(shape: Shape): string {
  if (!shape.snapshot) return "";

  const skipVersion = when(
    shape.versioned,
    joinLines(
      '    // `version` is this module\'s, so a caller who assigns to it has not made a change: the write it',
      "    // would provoke is one nobody asked for, and the value would be replaced on the way out anyway.",
      '    if (name === "version") {',
      "      continue;",
      "    }",
      "",
    ),
  );

  return sections(
    documented(
      [
        "The names of the fields a loaded record now differs in.",
        "Field by field with `Object.is`, over the union of both sets of names, so an added field and a deleted one both count. The comparison is shallow: the draft and the copy hold the *same* reference for a nested object, so replacing one is a change and reaching into one is not.",
        "The key field needs no exception here: `planned` refuses a draft whose key has moved before this ever runs.",
      ],
      dedent`
        function changedFields(registration: Registration): readonly string[] {
          const names = new Set([
            ...Object.keys(registration.loaded),
            ...Object.keys(registration.draft),
          ]);
          const changed: string[] = [];

          for (const name of [...names].sort()) {
        ${skipVersion}
            if (!Object.is(registration.loaded[name], registration.draft[name])) {
              changed.push(name);
            }
          }

          return changed;
        }
      `,
    ),
    documented(
      [
        "@throws KeyChangedError when a draft no longer holds the key it was tracked under.",
        "Checked for a new record as well as a loaded one: the identity map is keyed on the value read when the record was registered, so a draft that changed it afterwards would be written under one key while being found under another.",
      ],
      dedent`
        function assertKeyIntact(registration: Registration): void {
          if (registration.state === "removed") {
            return;
          }
          if (String(registration.draft[registration.keyField]) !== registration.key) {
            throw new KeyChangedError(registration.collection, registration.key);
          }
        }
      `,
    ),
  );
}

function slotFunction(): string {
  return documented(
    [
      "The identity-map key for one record.",
      "A NUL separator rather than a colon, because a collection name or a key that contained the separator would otherwise let two different records share a slot.",
    ],
    dedent`
      function slotFor(collection: string, key: string): string {
        return \`\${collection}\\u0000\${key}\`;
      }
    `,
  );
}

function withUnitOfWorkFunction(): string {
  return documented(
    [
      "Run a transaction: open a unit of work, hand it to `run`, and commit if `run` returns.",
      "The point is the failure path. If `run` throws, nothing is committed and nothing has been written, so a transaction abandoned halfway leaves the datastore as it was without anybody having to remember a rollback. Forgetting to commit is the other defect this closes, and the more common one.",
    ],
    dedent`
      export async function withUnitOfWork<R>(
        store: Store,
        run: (uow: UnitOfWork) => Promise<R>,
      ): Promise<R> {
        const uow = new UnitOfWork(store);
        const result = await run(uow);
        await uow.commit();
        return result;
      }
    `,
  );
}

function storeErrorClass(): string {
  return keyedError("AlreadyStoredError", '`A record in "${collection}" already has key "${key}".`', [
    "An insert named a key the store already holds.",
    "The store's error rather than the unit of work's: it is the only party that knows what is there. An insert that quietly became an update is how two transactions end up each believing it created the record.",
  ]);
}

// ---------------------------------------------------------------------------------------------------
// The binding: one entity, and nothing else.
// ---------------------------------------------------------------------------------------------------

/**
 * The per-entity half. Everything here is about one domain type and none of it is machinery, which is
 * what makes `binding-only` worth having: this file is a small fraction of the core beside it.
 */
function binding(context: RenderContext, names: Names, shape: Shape): string {
  return sections(
    doc(
      `The ${names.entity} collection: its minimum record, its name, and a typed accessor.`,
      `The machinery lives in \`${names.coreStem}\` and is shared with every other entity. Adding a second entity means a second file like this one, not a second copy of that.`,
    ),
    importsFrom(context.conventions, siblingSpecifier(context.conventions, names.coreStem), {
      types: [
        "CollectionSpec",
        ...(shape.versioned ? ["NewRecord"] : []),
        "Tracked",
        "UnitOfWork",
      ],
    }),
    bindingBody(names, shape),
  );
}

/**
 * The binding's declarations, without its imports or header.
 *
 * Separate because `core-only` has no binding file and its example and suite still need a collection to
 * demonstrate: a caller adopting the machinery is about to write exactly this, so it is declared inline
 * there rather than imported from a file that scope does not emit (see `assertSelfContained`).
 */
function bindingBody(names: Names, shape: Shape): string {
  const recordFields = joinLines(
    "  readonly id: string;",
    when(
      shape.versioned,
      joinLines(
        docAt(2, "Assigned on insert and incremented on every update by the unit of work, never by you."),
        "  readonly version: number;",
      ),
    ),
  );

  const addParameter = shape.versioned ? `NewRecord<T, "id">` : "T";

  return sections(
    documented(
      [
        `What \`${names.entity}\` must have for this module to track it.`,
        `Your own \`${names.entity}\` satisfies this by having an \`id\`${when(shape.versioned, " and a `version`")}, so nothing here needs to know the rest of its fields. That is deliberate: a generated file that declared your domain type would have to be edited every time the domain changed, and regenerating it would then overwrite the edit.`,
        "The key is a plain `string`. `branded-type` is how it stops being interchangeable with every other entity's key, and the change is confined to this file.",
      ],
      dedent`
        export interface ${names.recordType} {
        ${recordFields}
        }
      `,
    ),
    documented(
      [
        `Where ${names.entity} records live.`,
        "Exported so that a datastore adapter can be told which collections exist without importing every entity's accessor.",
      ],
      `export const ${names.collectionConst} = "${names.collection}";`,
    ),
    documented(
      [
        `Tracking ${names.collection} in one unit of work.`,
        `Generic in your own \`${names.entity}\`, so every method is typed in terms of your type rather than the minimum this file declares.`,
      ],
      dedent`
        export interface ${names.accessType}<T extends ${names.recordType}> {
          ${docAt(2, "The record under this key, or `undefined` if there is none.")}
          load(id: T["id"]): Promise<Tracked<T, "id"> | undefined>;
          ${docAt(2, "The record under this key, or an error naming what was missing.")}
          require(id: T["id"]): Promise<Tracked<T, "id">>;
          ${docAt(2, "Track a new record, to be inserted at commit.")}
          add(record: ${addParameter}): Tracked<T, "id">;
        }
      `,
    ),
    documented(
      [
        `What the machinery needs to know about ${names.collection}, at your own record type.`,
        `A function rather than a constant because it is specific to the \`T\` you use it at, and a constant would have to be declared at one of them. \`${names.accessor}\` calls it, and so does anything that has to name this collection to something entity-independent — an in-memory store's fixtures, for one.`,
      ],
      dedent`
        export function ${names.specFactory}<T extends ${names.recordType}>(): CollectionSpec<T, "id"> {
          return { collection: ${names.collectionConst}, keyField: "id" };
        }
      `,
    ),
    documented(
      [
        `Track ${names.collection} in \`uow\`.`,
        `Pass your domain type: \`${names.accessor}<${names.entity}>(uow)\`.`,
      ],
      dedent`
        export function ${names.accessor}<T extends ${names.recordType}>(
          uow: UnitOfWork,
        ): ${names.accessType}<T> {
          const spec = ${names.specFactory}<T>();

          return {
            load: (id) => uow.load<T, "id">(spec, id),
            require: (id) => uow.require<T, "id">(spec, id),
            add: (record) => uow.add<T, "id">(spec, record),
          };
        }
      `,
    ),
  );
}

function memoryStore(shape: Shape): string {
  const check = shape.versioned
    ? dedent`
        if (current === undefined || current["version"] !== operation.expectedVersion) {
          throw new ConcurrencyError(operation.collection, operation.key);
        }
      `
    : dedent`
        if (current === undefined) {
          throw new RecordNotFoundError(operation.collection, operation.key);
        }
      `;

  return documented(
    [
      "A complete `Store` held in memory.",
      "Not a mock: it honours the whole contract, including the part that matters most — every operation in a batch is checked before any of it is written, so a batch that cannot be applied leaves the store exactly as it was. A suite written against this exercises the unit of work rather than a stand-in for it.",
      "`seed` and `records` are here because this seam has no read-everything method: a store whose only read is by key needs a door for a test to look through, and putting one on `Store` itself would make every real adapter implement it.",
    ],
    dedent`
      export interface MemoryStore extends Store {
        ${docAt(2, "Put records in place without going through a unit of work, for a test's starting state.")}
        seed<T extends Storable<F>, F extends string>(
          spec: CollectionSpec<T, F>,
          records: readonly T[],
        ): void;
        ${docAt(2, "Everything in one collection, in insertion order. Typed by the same spec that seeded it, which is the only reason it can be typed at all — the table underneath has forgotten.")}
        records<T extends Storable<F>, F extends string>(
          spec: CollectionSpec<T, F>,
        ): readonly T[];
        ${docAt(2, "How many batches have been applied successfully. A test asserting that nothing was written asserts on this, since an empty batch is never sent and a refused one is not counted.")}
        readonly applied: number;
      }

      export function createMemoryStore(): MemoryStore {
        const collections = new Map<string, Map<string, Fields>>();
        let applied = 0;

        const rowsIn = (collection: string): Map<string, Fields> => {
          const existing = collections.get(collection);
          if (existing !== undefined) {
            return existing;
          }
          const created = new Map<string, Fields>();
          collections.set(collection, created);
          return created;
        };

        return {
          get applied(): number {
            return applied;
          },

          seed<T extends Storable<F>, F extends string>(
            spec: CollectionSpec<T, F>,
            records: readonly T[],
          ): void {
            const rows = rowsIn(spec.collection);
            for (const record of records) {
              rows.set(record[spec.keyField], fieldsOf(record));
            }
          },

          records<T extends Storable<F>, F extends string>(
            spec: CollectionSpec<T, F>,
          ): readonly T[] {
            return [...rowsIn(spec.collection).values()] as readonly T[];
          },

          read<T>(collection: string, key: string): Promise<T | undefined> {
            const found = rowsIn(collection).get(key);
            // A copy, so that a caller changing what it was handed cannot reach into the store. A real
            // adapter gets this for free by deserialising; an in-memory one has to mean it.
            return Promise.resolve(found === undefined ? undefined : ({ ...found } as T));
          },

          async apply(batch: readonly Operation[]): Promise<void> {
            // Every expectation first, every write second. That is the whole of what "atomic" means
            // here, and the reason the seam takes a batch rather than a connection.
            for (const operation of batch) {
              const current = rowsIn(operation.collection).get(operation.key);

              if (operation.kind === "insert") {
                if (current !== undefined) {
                  throw new AlreadyStoredError(operation.collection, operation.key);
                }
                continue;
              }

              ${check}
            }

            for (const operation of batch) {
              const rows = rowsIn(operation.collection);
              if (operation.kind === "delete") {
                rows.delete(operation.key);
              } else {
                rows.set(operation.key, operation.record);
              }
            }

            applied += 1;
            await Promise.resolve();
          },
        };
      }
    `,
  );
}

// ---------------------------------------------------------------------------------------------------
// The example, which FR-004 requires of every generative pattern and which is not the test file.
//
// The difference is what each is for: the suite proves the machinery correct and reads like a suite,
// while this shows what a caller writes on their first day and reads like their code.
// ---------------------------------------------------------------------------------------------------

function example(context: RenderContext, names: Names, shape: Shape): string {
  const coreSpec = siblingSpecifier(context.conventions, names.coreStem);
  const bindingSpec = siblingSpecifier(context.conventions, names.bindingStem);
  const inline = shape.standalone;

  const coreImports = importsFrom(context.conventions, coreSpec, {
    values: ["createMemoryStore", "withUnitOfWork"],
    types: [
      ...(inline ? ["CollectionSpec"] : []),
      ...(inline && shape.versioned ? ["NewRecord"] : []),
      "Store",
      "Tracked",
      ...(inline ? ["UnitOfWork"] : []),
    ],
  });

  const bindingImports = when(
    !inline,
    importsFrom(context.conventions, bindingSpec, {
      values: [names.accessor, names.specFactory],
      // The accessor's type is written down by one function — the refusal a versioned bundle states —
      // and everywhere else it is inferred at the call, which is what a caller does. Imported
      // unconditionally it was a type the file never mentioned.
      types: [names.recordType, ...(shape.versioned ? [names.accessType] : [])],
    }),
  );

  return sections(
    doc(
      `Using the ${names.entity} collection: one transaction, one commit.`,
      "Everything here is what a caller writes. The only thing worth watching is what is *not* written: a record that was read and not changed, and a record added and then removed, both cost nothing at commit.",
    ),
    coreImports,
    bindingImports,
    when(inline, bindingBody(names, shape)),
    exampleDomainType(names, shape),
    exampleTransaction(names, shape),
    exampleFailure(names, shape),
    exampleRun(names, shape),
    exampleRefusals(names, shape),
  );
}

function exampleDomainType(names: Names, shape: Shape): string {
  return documented(
    [
      `Your own \`${names.entity}\`. The collection requires an \`id\`${when(shape.versioned, " and a `version`")}; the rest is yours.`,
      ...(names.renamedSample
        ? [
            `Called \`${names.sampleType}\` here only because this module imports a \`${names.entity}\` of its own from the core, and one module cannot declare both. Your copy is yours to name \`${names.entity}\`.`,
          ]
        : []),
      ...(shape.snapshot
        ? [
            "Declared `readonly` even though a draft is mutable. `Draft<T>` removes the modifier for the copy the unit of work hands back, so the fields are writable exactly where writing them means something and nowhere else.",
          ]
        : []),
    ],
    dedent`
      export interface ${names.sampleType} extends ${names.recordType} {
        readonly total: number;
        readonly status: "open" | "paid";
      }
    `,
  );
}

function exampleTransaction(names: Names, shape: Shape): string {
  const accessor = when(
    shape.standalone,
    dedent`
      const spec: CollectionSpec<${names.sampleType}, "id"> = {
        collection: ${names.collectionConst},
        keyField: "id",
      };
    `,
    `const tracked = ${names.accessor}<${names.sampleType}>(uow);`,
  );

  const load = shape.standalone
    ? `const paid = await uow.require<${names.sampleType}, "id">(spec, "A-1");`
    : 'const paid = await tracked.require("A-1");';

  const change = shape.snapshot
    ? 'paid.draft.status = "paid";'
    : 'paid.update({ status: "paid" });';

  const add = shape.standalone
    ? `const followUp = uow.add<${names.sampleType}, "id">(spec, {\n      id: "A-2",\n      total: 0,\n      status: "open",\n    });`
    : 'const followUp = tracked.add({ id: "A-2", total: 0, status: "open" });';

  const changeFollowUp = shape.snapshot
    ? "followUp.draft.total = 250;"
    : "followUp.update({ total: 250 });";

  const unchanged = shape.standalone
    ? `await uow.load<${names.sampleType}, "id">(spec, "A-3");`
    : 'await tracked.load("A-3");';

  return documented(
    [
      "One business transaction: settle an order and open its follow-up.",
      "Both changes reach the store in a single batch, or neither does. Note the third record: it is read and not changed, so it produces no write at all — a unit of work that wrote back everything it had seen would conflict with every other transaction that had merely read the same row.",
    ],
    dedent`
      export async function ${names.exampleFn}(store: Store): Promise<readonly string[]> {
        return withUnitOfWork(store, async (uow) => {
          ${accessor}

          ${load}
          ${change}

          ${add}
          ${changeFollowUp}

          // Read, considered, left alone.
          ${unchanged}

          // Nothing has been written yet. This is the whole of what commit will do.
          return uow.plan().map((operation) => \`\${operation.kind} \${operation.key}\`);
        });
      }
    `,
  );
}

function exampleFailure(names: Names, shape: Shape): string {
  const accessor = when(
    shape.standalone,
    dedent`
      const spec: CollectionSpec<${names.sampleType}, "id"> = {
        collection: ${names.collectionConst},
        keyField: "id",
      };
    `,
    `const tracked = ${names.accessor}<${names.sampleType}>(uow);`,
  );

  const load = shape.standalone
    ? `const order = await uow.require<${names.sampleType}, "id">(spec, "A-1");`
    : 'const order = await tracked.require("A-1");';

  const change = shape.snapshot ? "order.draft.total = 0;" : "order.update({ total: 0 });";

  return documented(
    [
      "A transaction that decides against itself halfway through.",
      "The change above the throw is never written, and there is no rollback to forget: nothing had been written to undo.",
    ],
    dedent`
      export async function abandon${names.entity}(store: Store): Promise<string> {
        try {
          await withUnitOfWork(store, async (uow) => {
            ${accessor}

            ${load}
            ${change}

            throw new Error("a domain rule said no");
          });
          return "committed";
        } catch {
          return "nothing written";
        }
      }
    `,
  );
}

function exampleRun(names: Names, shape: Shape): string {
  // The spec, which a full bundle imports from the binding and `core-only` declared above.
  const spec = shape.standalone
    ? dedent`
        const spec: CollectionSpec<${names.sampleType}, "id"> = {
          collection: ${names.collectionConst},
          keyField: "id",
        };
      `
    : `const spec = ${names.specFactory}<${names.sampleType}>();`;

  const rows = shape.versioned
    ? dedent`
        { id: "A-1", total: 100, status: "open", version: 1 },
        { id: "A-3", total: 40, status: "paid", version: 7 },
      `
    : dedent`
        { id: "A-1", total: 100, status: "open" },
        { id: "A-3", total: 40, status: "paid" },
      `;

  const seed = dedent`
    ${spec}
    store.seed(spec, [
      ${rows}
    ]);
  `;

  return documented(
    [
      "Both of the above against an in-memory store, which is what to run before a datastore exists.",
    ],
    dedent`
      export async function demonstrate(): Promise<{
        readonly planned: readonly string[];
        readonly abandoned: string;
        readonly stored: number;
      }> {
        const store = createMemoryStore();
        ${seed}

        const planned = await ${names.exampleFn}(store);
        const abandoned = await abandon${names.entity}(store);

        return { planned, abandoned, stored: store.records(spec).length };
      }
    `,
  );
}

function exampleRefusals(names: Names, shape: Shape): string {
  const change = shape.snapshot
    ? dedent`
        // The draft's fields are the entity's fields, so its own types still hold.
        // @ts-expect-error a status the entity does not have
        order.draft.status = "refunded";

        // @ts-expect-error the wrong type for a real field
        order.draft.total = "lots";
      `
    : dedent`
        // @ts-expect-error the key field is absent from a patch, so identity cannot change
        order.update({ id: "A-9" });

        // @ts-expect-error a field the entity does not have
        order.update({ discount: 10 });

        // @ts-expect-error the wrong type for a real field
        order.update({ total: "lots" });
      `;

  const versionRefusal = when(
    shape.versioned,
    dedent`
      /**
       * The version is assigned, not supplied.
       *
       * Worth asserting rather than documenting: a caller who sets it is stating a fact about a record
       * that does not exist yet, and the value they choose would be silently replaced.
       */
      export function refusesASuppliedVersion(
        ${shape.standalone ? "uow: UnitOfWork, spec: CollectionSpec<" + names.sampleType + ', "id">' : "tracked: " + names.accessType + "<" + names.sampleType + ">"},
      ): void {
        // The directive sits on the offending property rather than above the call: it suppresses the
        // line that follows it, and the excess property is reported where it is written.
        ${shape.standalone ? `uow.add<${names.sampleType}, "id">(spec, {` : "tracked.add({"}
          id: "A-9",
          total: 1,
          status: "open",
          // @ts-expect-error version is not part of a new record
          version: 1,
        ${shape.standalone ? "});" : "});"}
      }
    `,
  );

  return sections(
    documented(
      [
        "What the compiler refuses, stated as code that must not compile.",
        "Each directive is an assertion: if the guarantee above it lapses, the directive goes unused and this file stops compiling on that instead.",
      ],
      dedent`
        export function refusesImpossibleChanges(order: Tracked<${names.sampleType}, "id">): void {
          ${change}
        }
      `,
    ),
    versionRefusal,
    documented(
      [
        "A record nobody is watching is not a tracked one.",
        "The reason to reach for this pattern at all: a function that means to change something persistently says so in its parameter type, and cannot be handed a record whose changes would go nowhere.",
      ],
      dedent`
        export function refusesAnUntrackedRecord(order: ${names.sampleType}): void {
          // Written as a direct call rather than through a callback. Argument assignability at a call is
          // invariant at every strictness; a callback parameter is compared bivariantly without
          // \`strictFunctionTypes\`, which would make this compile under a loose configuration and leave
          // the directive unused.
          // @ts-expect-error a plain record has no handle, so nothing here would ever be written
          refusesImpossibleChanges(order);
        }
      `,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The suite.
//
// What it is for is worth stating: it does not test that the emitted code compiles — generation already
// established that — it tests the claims the doc comments make. Almost all of them are about what is
// *not* written, and none of those is visible in a type.
// ---------------------------------------------------------------------------------------------------

function tests(context: RenderContext, names: Names, shape: Shape): string {
  const coreSpec = siblingSpecifier(context.conventions, names.coreStem);
  const bindingSpec = siblingSpecifier(context.conventions, names.bindingStem);
  const inline = shape.standalone;

  return sections(
    doc(
      `A unit of work over ${names.collection}, exercised against the in-memory store.`,
      "Nothing here is mocked. The store is a real implementation of the seam a datastore adapter implements, so a failure means the unit of work is wrong rather than that a stub disagreed with it.",
    ),
    joinLines(
      frameworkImports(context.conventions),
      importsFrom(context.conventions, coreSpec, {
        values: [
          "AlreadyStoredError",
          "AlreadyTrackedError",
          ...(shape.versioned ? ["ConcurrencyError"] : []),
          ...(shape.snapshot ? ["KeyChangedError"] : []),
          "RecordNotFoundError",
          ...(shape.snapshot ? [] : ["RemovedRecordError"]),
          "UnitOfWork",
          "UnitOfWorkClosedError",
          "createMemoryStore",
          "withUnitOfWork",
        ],
        types: [
          ...(inline ? ["CollectionSpec"] : []),
          "MemoryStore",
          ...(inline && shape.versioned ? ["NewRecord"] : []),
          "Tracked",
        ],
      }),
      when(
        !inline,
        importsFrom(context.conventions, bindingSpec, {
          // The collection's name is spoken by one case, which needs to commit behind the unit of
          // work's back — so only a versioned bundle has anything to name it for.
          values: [
            names.accessor,
            ...(shape.versioned ? [names.collectionConst] : []),
            names.specFactory,
          ],
          types: [names.recordType, names.accessType],
        }),
      ),
    ),
    when(
      inline,
      sections(
        doc(
          "The binding under test, which a full bundle would have as its own file.",
          "This scope emitted the machinery alone, so the suite declares the collection it exercises rather than importing one that is not there.",
        ),
        bindingBody(names, shape),
      ),
    ),
    testFixtures(names, shape),
    testAdapters(names, shape),
    testCases(names, shape),
  );
}

function testFixtures(names: Names, shape: Shape): string {
  const rows = shape.versioned
    ? dedent`
        { id: "A-1", total: 100, status: "open", shipping: { city: "York" }, version: 1 },
        { id: "A-2", total: 40, status: "paid", shipping: { city: "Leeds" }, version: 7 },
      `
    : dedent`
        { id: "A-1", total: 100, status: "open", shipping: { city: "York" } },
        { id: "A-2", total: 40, status: "paid", shipping: { city: "Leeds" } },
      `;

  return sections(
    documented(
      [
        "The domain type the suite tracks, standing in for the caller's own.",
        "`shipping` is here because a nested field is where a change-detection rule either holds or does not, and a suite of scalars would never find out.",
      ],
      dedent`
        interface ${names.sampleType} extends ${names.recordType} {
          readonly total: number;
          readonly status: "open" | "paid";
          readonly shipping: { city: string };
        }
      `,
    ),
    documented(
      [
        "A store with two records in it, and a unit of work over that store.",
        "The spec is the same one the accessor uses, which is what lets the store's fixtures be typed as this suite's own record type rather than as bags of fields.",
      ],
      dedent`
        const spec = ${names.specFactory}<${names.sampleType}>();

        function seeded(): MemoryStore {
          const store = createMemoryStore();
          store.seed(spec, [
            ${rows}
          ]);
          return store;
        }

        function opened(store: MemoryStore): {
          readonly uow: UnitOfWork;
          readonly ${names.collection}: ${names.accessType}<${names.sampleType}>;
        } {
          const uow = new UnitOfWork(store);
          return { uow, ${names.collection}: ${names.accessor}<${names.sampleType}>(uow) };
        }

        function stored(store: MemoryStore, id: string): ${names.sampleType} | undefined {
          return store.records(spec).find((row) => row.id === id);
        }
      `,
    ),
    documented(
      ["The plan as short strings, which is what most of these cases are really about."],
      dedent`
        function planOf(uow: UnitOfWork): readonly string[] {
          return uow.plan().map((operation) => \`\${operation.kind} \${operation.key}\`);
        }
      `,
    ),
    documented(
      [
        "Whatever a call refused with.",
        "Handed to `toBeInstanceOf` rather than matching on the message, so the assertion is about which refusal it was and not about its wording — the wording is free to improve.",
      ],
      dedent`
        function refusalFrom(run: () => void): unknown {
          try {
            run();
          } catch (error: unknown) {
            return error;
          }
          throw new Error("expected a refusal, and the call returned");
        }
      `,
    ),
  );
}

/**
 * The two-function difference between the tracking renderings.
 *
 * Every case below is spelled the same way in both, which is deliberate: the axis is how a change is
 * expressed and not what a change means, so a suite that branched at every call site would be asserting
 * that two different suites both pass rather than that one property holds either way.
 */
function testAdapters(names: Names, shape: Shape): string {
  const body = shape.snapshot
    ? dedent`
        function change(
          order: Tracked<${names.sampleType}, "id">,
          fields: { readonly total?: number; readonly status?: "open" | "paid" },
        ): void {
          if (fields.total !== undefined) {
            order.draft.total = fields.total;
          }
          if (fields.status !== undefined) {
            order.draft.status = fields.status;
          }
        }

        function totalOf(order: Tracked<${names.sampleType}, "id">): number {
          return order.draft.total;
        }
      `
    : dedent`
        function change(
          order: Tracked<${names.sampleType}, "id">,
          fields: { readonly total?: number; readonly status?: "open" | "paid" },
        ): void {
          order.update(fields);
        }

        function totalOf(order: Tracked<${names.sampleType}, "id">): number {
          return order.value.total;
        }

        function statusOf(order: Tracked<${names.sampleType}, "id">): string {
          return order.value.status;
        }
      `;

  return documented(
    [
      "Making a change, however this bundle spells it.",
      "The rest of the suite is identical in both renderings, which is the point: how a change is expressed is an option, what a change *means* is not.",
      "Reading the status is the one adapter the snapshot rendering does not need. Only the merging case asks for it — a patch is a thing the explicit rendering has and the snapshot one does not — and an adapter no case calls is dead however symmetrical it looks.",
    ],
    body,
  );
}

function describeBlock(name: string, body: string): string {
  return dedent`
    describe("${name}", () => {
      ${body}
    });
  `;
}

function testCase(name: string, body: string): string {
  return dedent`
    it("${name}", async () => {
      ${body}
    });
  `;
}

function testCases(names: Names, shape: Shape): string {
  const it = names.collection;
  const version = when(shape.versioned, ", version: 1");

  return sections(
    describeBlock(
      "what reaches the store",
      sections(
        testCase(
          "nothing at all before commit",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const order = await ${it}.require("A-1");
            change(order, { status: "paid" });

            expect(store.applied).toBe(0);
            expect(stored(store, "A-1")?.status).toBe("open");
            expect(planOf(uow)).toEqual(["update A-1"]);
          `,
        ),
        testCase(
          "no write for a record that was read and not changed",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            await ${it}.require("A-1");
            await ${it}.require("A-2");

            expect(uow.plan()).toHaveLength(0);
            await uow.commit();
            expect(store.applied).toBe(0);
          `,
        ),
        testCase(
          "one insert carrying every change made to a new record",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const added = ${it}.add({
              id: "A-9",
              total: 1,
              status: "open",
              shipping: { city: "Hull" },
            });
            change(added, { total: 7 });

            expect(planOf(uow)).toEqual(["insert A-9"]);
            await uow.commit();

            expect(stored(store, "A-9")?.total).toBe(7);
          `,
        ),
        testCase(
          "nothing for a record added and then removed",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const added = ${it}.add({
              id: "A-9",
              total: 1,
              status: "open",
              shipping: { city: "Hull" },
            });
            added.remove();

            expect(uow.plan()).toHaveLength(0);
            await uow.commit();
            expect(store.applied).toBe(0);
            expect(store.records(spec)).toHaveLength(2);
          `,
        ),
        testCase(
          "a delete and nothing else for a record changed and then removed",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const order = await ${it}.require("A-1");
            change(order, { total: 999 });
            order.remove();

            expect(planOf(uow)).toEqual(["delete A-1"]);
            await uow.commit();
            expect(store.records(spec)).toHaveLength(1);
          `,
        ),
        testCase(
          "one delete however many times a record is removed",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const order = await ${it}.require("A-1");
            order.remove();
            order.remove();

            expect(planOf(uow)).toEqual(["delete A-1"]);
          `,
        ),
        testCase(
          "inserts, then updates, then deletes, in the order they were registered",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const first = await ${it}.require("A-1");
            first.remove();
            ${it}.add({ id: "A-8", total: 1, status: "open", shipping: { city: "Hull" } });
            const second = await ${it}.require("A-2");
            change(second, { total: 5 });
            ${it}.add({ id: "A-7", total: 1, status: "open", shipping: { city: "Hull" } });

            expect(planOf(uow)).toEqual([
              "insert A-8",
              "insert A-7",
              "update A-2",
              "delete A-1",
            ]);
          `,
        ),
      ),
    ),
    describeBlock(
      "what the transaction sees of itself",
      sections(
        testCase(
          "one handle for a record loaded twice",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const first = await ${it}.require("A-1");
            const second = await ${it}.require("A-1");

            expect(first).toBe(second);
            change(first, { total: 42 });
            expect(totalOf(second)).toBe(42);
            expect(planOf(uow)).toEqual(["update A-1"]);
          `,
        ),
        testCase(
          "a record added is found by load, without the store being read",
          dedent`
            const store = seeded();
            const { ${it} } = opened(store);

            const added = ${it}.add({
              id: "A-9",
              total: 1,
              status: "open",
              shipping: { city: "Hull" },
            });

            expect(await ${it}.load("A-9")).toBe(added);
          `,
        ),
        testCase(
          "a record removed reads as absent",
          dedent`
            const store = seeded();
            const { ${it} } = opened(store);

            const order = await ${it}.require("A-1");
            order.remove();

            expect(await ${it}.load("A-1")).toBeUndefined();
          `,
        ),
      ),
    ),
    describeBlock(
      "what it refuses",
      sections(
        testCase(
          "a key it is already tracking",
          dedent`
            const store = seeded();
            const { ${it} } = opened(store);

            await ${it}.require("A-1");

            expect(
              refusalFrom(() => {
                ${it}.add({
                  id: "A-1",
                  total: 1,
                  status: "open",
                  shipping: { city: "Hull" },
                });
              }),
            ).toBeInstanceOf(AlreadyTrackedError);
          `,
        ),
        testCase(
          "a record that has to exist and does not",
          dedent`
            const store = seeded();
            const { ${it} } = opened(store);

            await expect(${it}.require("A-404")).rejects.toBeInstanceOf(RecordNotFoundError);
            expect(await ${it}.load("A-404")).toBeUndefined();
          `,
        ),
        testCase(
          "everything, once it has been committed",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const order = await ${it}.require("A-1");
            change(order, { total: 1 });
            await uow.commit();

            await expect(uow.commit()).rejects.toBeInstanceOf(UnitOfWorkClosedError);
            await expect(${it}.load("A-2")).rejects.toBeInstanceOf(UnitOfWorkClosedError);
            expect(
              refusalFrom(() => {
                ${it}.add({
                  id: "A-9",
                  total: 1,
                  status: "open",
                  shipping: { city: "Hull" },
                });
              }),
            ).toBeInstanceOf(UnitOfWorkClosedError);
            expect(
              refusalFrom(() => {
                order.remove();
              }),
            ).toBeInstanceOf(UnitOfWorkClosedError);
          `,
        ),
        trackingRefusal(names, shape),
      ),
    ),
    describeBlock(
      "what a change is",
      sections(...changeCases(names, shape)),
    ),
    describeBlock(
      "one transaction, or none of it",
      sections(
        testCase(
          "an abandoned transaction writes nothing",
          dedent`
            const store = seeded();

            await expect(
              withUnitOfWork(store, async (uow) => {
                const order = await ${names.accessor}<${names.sampleType}>(uow).require("A-1");
                change(order, { status: "paid" });
                throw new Error("a domain rule said no");
              }),
            ).rejects.toBeInstanceOf(Error);

            expect(store.applied).toBe(0);
            expect(stored(store, "A-1")?.status).toBe("open");
          `,
        ),
        testCase(
          "a commit that fails leaves the unit of work open",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            // A key the store holds and this unit of work never loaded, so only the store can refuse it.
            ${it}.add({ id: "A-1", total: 1, status: "open", shipping: { city: "Hull" } });

            await expect(uow.commit()).rejects.toBeInstanceOf(AlreadyStoredError);
            expect(planOf(uow)).toEqual(["insert A-1"]);
            expect(store.records(spec)).toHaveLength(2);
            expect(store.applied).toBe(0);

            // Still usable, which is the whole claim: nothing was written, so the caller can look at
            // what happened and decide. A unit of work closed by a failure would swallow this.
            expect(await ${it}.require("A-2")).toBeDefined();
          `,
        ),
        testCase(
          "a commit that succeeded has nothing left to do",
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            const kept = await ${it}.require("A-1");
            change(kept, { total: 7 });
            const gone = await ${it}.require("A-2");
            gone.remove();
            ${it}.add({ id: "A-9", total: 1, status: "open", shipping: { city: "Hull" } });
            await uow.commit();

            // \`plan\` is the one method a closed unit of work still answers, so it has to answer
            // truthfully: every accumulated change has been written and none of it is pending.
            expect(uow.plan()).toHaveLength(0);
            expect(store.applied).toBe(1);
          `,
        ),
        ...(shape.versioned
          ? [
              testCase(
                "a conflict names the record, and nothing in the batch is written",
                dedent`
                  const store = seeded();
                  const { uow, ${it} } = opened(store);

                  const order = await ${it}.require("A-1");
                  change(order, { total: 999 });
                  ${it}.add({ id: "A-9", total: 1, status: "open", shipping: { city: "Hull" } });

                  // Somebody else commits first.
                  await store.apply([
                    {
                      kind: "update",
                      collection: ${names.collectionConst},
                      key: "A-1",
                      record: {
                        id: "A-1",
                        total: 101,
                        status: "open",
                        shipping: { city: "York" },
                        version: 2,
                      },
                      expectedVersion: 1,
                    },
                  ]);

                  await expect(uow.commit()).rejects.toBeInstanceOf(ConcurrencyError);
                  expect(stored(store, "A-9")).toBeUndefined();
                `,
              ),
              testCase(
                "a committed record carries the version that was stored",
                dedent`
                  const store = seeded();
                  const { uow, ${it} } = opened(store);

                  const order = await ${it}.require("A-2");
                  change(order, { total: 41 });
                  await uow.commit();

                  expect(stored(store, "A-2")?.version).toBe(8);
                  // The record still in hand agrees, so its next write will not conflict for no reason.
                  expect(order${shape.snapshot ? ".draft" : ".value"}.version).toBe(8);
                  expect(order${shape.snapshot ? ".draft" : ".value"}.version).toBeGreaterThan(7);
                `,
              ),
            ]
          : []),
        testCase(
          `a new record is inserted with everything it was given${when(shape.versioned, " and a version of one")}`,
          dedent`
            const store = seeded();
            const { uow, ${it} } = opened(store);

            ${it}.add({ id: "A-9", total: 3, status: "open", shipping: { city: "Hull" } });
            await uow.commit();

            expect(stored(store, "A-9")).toEqual({
              id: "A-9",
              total: 3,
              status: "open",
              shipping: { city: "Hull" }${version},
            });
          `,
        ),
      ),
    ),
  );
}

function trackingRefusal(names: Names, shape: Shape): string {
  const it = names.collection;

  if (shape.snapshot) {
    return testCase(
      "a draft whose key was changed, when the commit comes to run",
      dedent`
        const store = seeded();
        const { uow, ${it} } = opened(store);

        const order = await ${it}.require("A-1");
        order.draft.id = "A-2";

        // Not a compile error, and it cannot be: \`readonly\` on the key would refuse this line and
        // nothing that passes the draft to a function, since TypeScript does not check \`readonly\` in
        // assignability.
        await expect(uow.commit()).rejects.toBeInstanceOf(KeyChangedError);
        expect(store.applied).toBe(0);
      `,
    );
  }

  return testCase(
    "a change to a record that was removed",
    dedent`
      const store = seeded();
      const { ${it} } = opened(store);

      const order = await ${it}.require("A-1");
      order.remove();

      expect(
        refusalFrom(() => {
          change(order, { total: 1 });
        }),
      ).toBeInstanceOf(RemovedRecordError);
    `,
  );
}

function changeCases(names: Names, shape: Shape): readonly string[] {
  const it = names.collection;

  if (shape.snapshot) {
    return [
      testCase(
        "setting a field to the value it already had is not one",
        dedent`
          const store = seeded();
          const { uow, ${it} } = opened(store);

          const order = await ${it}.require("A-1");
          order.draft.total = 100;
          order.draft.status = "open";

          expect(uow.plan()).toHaveLength(0);
        `,
      ),
      testCase(
        "replacing a nested object is one, and reaching into it is not",
        dedent`
          const store = seeded();
          const reached = opened(store);
          const held = await reached.${it}.require("A-1");
          held.draft.shipping.city = "Leeds";

          // The draft and the copy taken at load hold the same nested object, so there is nothing to
          // compare. Stated as a test rather than a caveat, so that nobody deepens the comparison by
          // accident and nobody expects it to be deep.
          expect(reached.uow.plan()).toHaveLength(0);

          const replaced = opened(seeded());
          const other = await replaced.${it}.require("A-1");
          other.draft.shipping = { city: "Leeds" };

          expect(planOf(replaced.uow)).toEqual(["update A-1"]);
        `,
      ),
      ...(shape.versioned
        ? [
            testCase(
              "assigning to the version is not one, and does not survive",
              dedent`
                const store = seeded();
                const { uow, ${it} } = opened(store);

                const untouched = await ${it}.require("A-1");
                untouched.draft.version = 99;

                // The draft is mutable in every field, so this compiles; the field belongs to the unit
                // of work, so it is neither a change nor a value that reaches the store.
                expect(uow.plan()).toHaveLength(0);

                const changed = await ${it}.require("A-2");
                changed.draft.version = 99;
                changed.draft.total = 41;
                await uow.commit();

                expect(stored(store, "A-2")?.version).toBe(8);
              `,
            ),
          ]
        : []),
      testCase(
        "a change made after a record is removed is simply not written",
        dedent`
          const store = seeded();
          const { uow, ${it} } = opened(store);

          const order = await ${it}.require("A-1");
          order.remove();
          order.draft.total = 1;

          // Nothing can refuse this: the draft is a plain object and no method was called. The delete
          // stands, which is the only sensible reading of the two instructions together, and
          // \`tracking: "explicit"\` is the rendering that can say so at the point of the mistake.
          expect(planOf(uow)).toEqual(["delete A-1"]);
        `,
      ),
    ];
  }

  return [
    testCase(
      "a patch merges rather than replacing",
      dedent`
        const store = seeded();
        const { uow, ${it} } = opened(store);

        const order = await ${it}.require("A-1");
        order.update({ total: 7 });
        order.update({ status: "paid" });

        expect(totalOf(order)).toBe(7);
        expect(statusOf(order)).toBe("paid");
        expect(planOf(uow)).toEqual(["update A-1"]);
      `,
    ),
    testCase(
      "an undefined value is not a change, and does not erase the field",
      dedent`
        const store = seeded();
        const { uow, ${it} } = opened(store);

        const order = await ${it}.require("A-1");
        // What a caller reaches for when a form field was left blank. Erasing a field has to be said in
        // the domain type — with a null, or an absent-marker of its own — because a \`Partial\` cannot
        // tell "leave it alone" from "clear it".
        order.update({ total: undefined });

        expect(uow.plan()).toHaveLength(0);
        expect(totalOf(order)).toBe(100);
      `,
    ),
    testCase(
      "an empty patch is not a change",
      dedent`
        const store = seeded();
        const { uow, ${it} } = opened(store);

        const order = await ${it}.require("A-1");
        order.update({});

        expect(uow.plan()).toHaveLength(0);
      `,
    ),
  ];
}
