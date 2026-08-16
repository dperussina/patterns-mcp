/**
 * The `decorator` pattern: one behaviour wrapped around every method of an object.
 *
 * The textbook decorator implements the wrapped interface and forwards what it does not change, and in
 * TypeScript that part is already safe: a class declaring `implements Port` cannot omit a member, so the
 * compiler catches the forgotten forward without help. Generating it would produce a class whose body is
 * delegation — the failure research §9 describes, where a model writes the code unaided and the hard part
 * was never the part generated.
 *
 * The case the textbook does not cover is the one worth generating: a *single* concern applied across
 * every method at once — timing, logging, authorisation, caching — where the per-method decorator is
 * exactly the wrong shape. Written by hand it is N copies of the same wrapper, and the copies drift; worse,
 * a method added later gets none of them, silently, and the concern that was supposed to be universal is
 * quietly not.
 *
 * Two things make that hard enough to be worth emitting.
 *
 * The first is types. A concern that sees each call has to see *that* call's parameters and return type,
 * or it cannot forward them: a wrapper typed `(...args: unknown[]) => unknown` compiles and then makes
 * every call site lie. So the interception carries `K extends MethodKeys<Subject>` and derives its
 * arguments and result from `Subject[K]`, which is what lets one function body serve every method while
 * `proceed` still returns the right thing.
 *
 * The second is that an interface has no members at run time. Something must supply the list, and the two
 * honest answers are genuinely different, which is why `dispatch` is an option rather than a decision made
 * here. A manifest is checked — typed to require every method, so adding one to the subject breaks the
 * build instead of escaping the concern — and a `Proxy` needs no list at all but is an exotic object with
 * costs a caller should choose knowingly.
 *
 * One correctness note that the proxy rendering exists to get right, because the obvious version is wrong:
 * `Reflect.get(target, property, receiver)` — the form the MDN examples use — runs a getter with `this`
 * bound to the proxy, and a class whose getter reads a `#private` field then throws at run time, because
 * the proxy is not an instance that declared it. The receiver has to be the target. This was verified
 * against a class with private state rather than reasoned about.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { expectFileEntry } from "../expect-file.js";
import {
  dedent,
  documented,
  joinLines,
  sections,
  when,
} from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const decoratorPattern: PatternModule = {
  name: "decorator",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      proxied: options.dispatch === "proxy",
      stacking: options.stacking !== false,
      names: namesFor(context),
    };
    const n = shape.names;

    const files: RenderedFile[] = [
      { path: `${n.stem}.ts`, role: "core", contents: core(shape) },
      {
        path: `${n.stem}-example.ts`,
        role: "example",
        contents: example(context, shape),
      },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({
        path: `${n.stem}.test.ts`,
        role: "test",
        contents: tests(context, shape),
      });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

interface Shape {
  readonly proxied: boolean;
  readonly stacking: boolean;
  readonly names: Names;
}

/** Every name the templates use, derived once so two files cannot disagree about one. */
interface Names {
  readonly stem: string;
  /** The keys worth wrapping: `OrderMethodKeys`. */
  readonly methodKeys: string;
  /** One intercepted call: `OrderCall`. */
  readonly call: string;
  /** The concern itself: `OrderDecoration`. */
  readonly decoration: string;
  /** The manifest of members to wrap: `OrderMethods`. */
  readonly manifest: string;
  /** The entry point: `decorateOrder`. */
  readonly decorate: string;
  /** The combinator: `layerOrderDecorations`. */
  readonly layer: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;

  return {
    stem: entity === undefined ? "decorator" : `${entity.kebab}-decorator`,
    methodKeys: `${prefix}MethodKeys`,
    call: `${prefix}Call`,
    decoration: `${prefix}Decoration`,
    manifest: `${prefix}Methods`,
    decorate: `decorate${prefix === "" ? "Subject" : prefix}`,
    layer: `layer${prefix}Decorations`,
  };
}

function core(shape: Shape): string {
  return sections(
    methodTypes(shape),
    callType(shape),
    decorationType(shape),
    when(!shape.proxied, manifestType(shape)),
    decorateFunction(shape),
    when(shape.stacking, layerFunction(shape)),
  );
}

function methodTypes(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "Which members of a subject are worth wrapping.",
        "`(...args: never[]) => unknown` rather than `Function` or `(...args: any[]) => any`: `never[]` in the parameter position accepts a method of any signature, because a parameter list is contravariant and `never` is the bottom of it, while `Function` would also admit a class constructor and `any` would put a hole in the very types this pattern exists to keep exact.",
        "`-?` matters for the same reason it does in a field mapping. Without it an optional method arrives as `Method | undefined`, which satisfies nothing, and the key silently drops out of the union — so an optional method would be quietly unwrappable. `NonNullable` then asks the question about the method rather than about its optionality.",
        "A non-callable member is deliberately absent from the union. A decorated subject still exposes it, unchanged; there is simply nothing to put around a string.",
      ],
      dedent`
        type AnyMethod = (...args: never[]) => unknown;

        export type ${n.methodKeys}<Subject> = {
          [K in keyof Subject]-?: NonNullable<Subject[K]> extends AnyMethod ? K : never;
        }[keyof Subject];
      `,
    ),
    documented(
      [
        "One method of the subject, and the pieces of its signature the concern needs.",
        "Three aliases rather than the extraction written inline three times, because `Extract<NonNullable<Subject[K]>, AnyMethod>` appearing in a signature is the kind of thing a reader stops trusting and a maintainer stops updating in all three places.",
      ],
      dedent`
        type MethodOf<Subject, K extends keyof Subject> = Extract<NonNullable<Subject[K]>, AnyMethod>;
        type ArgsOf<Subject, K extends keyof Subject> = Parameters<MethodOf<Subject, K>>;
        type ResultOf<Subject, K extends keyof Subject> = ReturnType<MethodOf<Subject, K>>;
      `,
    ),
  );
}

function callType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "One call, on its way through.",
      "`member` is the literal key rather than `string`, so a concern that behaves differently for one method — retry the writes, cache the reads — can `switch` on it and be told when it names something the subject does not have.",
      "`args` and `proceed` are both derived from `Subject[K]`, which is the whole point: one concern body serves every method, and inside it the arguments are that method's arguments and `proceed` returns that method's return type. A wrapper typed with `unknown[]` would compile and then oblige every call site to cast.",
      "`proceed` takes arguments rather than reading `args`, so a concern that means to change them — a default filled in, a value redacted — passes them, and one that does not writes `proceed(...call.args)`. Forwarding is a decision, not an accident.",
    ],
    dedent`
      export interface ${n.call}<Subject, K extends ${n.methodKeys}<Subject>> {
        readonly member: K;
        readonly args: ArgsOf<Subject, K>;
        proceed(...args: ArgsOf<Subject, K>): ResultOf<Subject, K>;
      }
    `,
  );
}

function decorationType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The behaviour to wrap around every method.",
      "Generic in `K`, and it has to be: the type parameter is bound when the decoration is *called*, once per method, which is what lets one function be correct for all of them. Written as `(call: OrderCall<Subject, OrderMethodKeys<Subject>>) => …` instead, the argument would be a union and the return type would have to satisfy every method at once.",
      "A decoration that must not change the result returns `call.proceed(...call.args)`. One that must — a cache, a fallback — returns a value of the method's own return type, and the compiler holds it to that.",
      "Not async, deliberately. A concern that needs to await a promise-returning method awaits inside itself and returns the promise, which is the only version that works for a subject with both synchronous and asynchronous methods. Making the decoration itself `async` would turn every synchronous method into a promise-returning one and change the subject's type.",
    ],
    dedent`
      export type ${n.decoration}<Subject> = <K extends ${n.methodKeys}<Subject>>(
        call: ${n.call}<Subject, K>,
      ) => ResultOf<Subject, K>;
    `,
  );
}

function manifestType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Which members to wrap, named because an interface has none at run time.",
      "This is the type doing the work in this rendering. Requiring *every* method — mapped over `OrderMethodKeys` with nothing optional — means adding a method to the subject makes existing manifests a compile error that names the missing one. That is the failure mode this pattern is for: a method added a year later that silently receives none of the concerns the rest of the object has.",
      "`true` rather than `boolean` so that `false` is not a way to write a manifest that type-checks while omitting a method. Skipping one is expressible, and the way to express it is in the decoration, which can see `member` and decide.",
    ],
    dedent`
      export type ${n.manifest}<Subject> = {
        readonly [K in ${n.methodKeys}<Subject>]: true;
      };
    `,
  );
}

function decorateFunction(shape: Shape): string {
  return shape.proxied ? proxyDecorate(shape) : manifestDecorate(shape);
}

function proxyDecorate(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The subject, with every method wrapped, and the same type as the subject.",
      "The return type is `Subject` because a decorator that is not substitutable for what it decorates is not a decorator. Nothing downstream needs to know this happened.",
      "The receiver passed to `Reflect.get` is the *target*, not the proxy, and that is not a detail. The usual spelling — `Reflect.get(target, property, receiver)` — runs a getter with `this` bound to the proxy, so a subject whose getter reads a `#private` field throws at run time: the proxy is not an instance that declared the field. Binding to the target is what makes a class with private state work.",
      "A member is treated as a method when its value is callable, which is a run-time question and therefore answered slightly differently than the type is. A property holding a function is indistinguishable from a method here and will be wrapped; a getter returning one likewise. That is the cost of needing no list, and it is why `dispatch: manifest` is the default.",
    ],
    dedent`
      export function ${n.decorate}<Subject extends object>(
        subject: Subject,
        decoration: ${n.decoration}<Subject>,
      ): Subject {
        return new Proxy(subject, {
          get(target, property): unknown {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;

            const member = property as ${n.methodKeys}<Subject>;

            return (...args: never[]): unknown =>
              decoration({
                member,
                args: args as ArgsOf<Subject, typeof member>,
                proceed: (...passed: never[]): never =>
                  Reflect.apply(value as AnyMethod, target, passed) as never,
              });
          },
        });
      }
    `,
  );
}

function manifestDecorate(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "The subject, with every named method wrapped, and the same type as the subject.",
        "The return type is `Subject` because a decorator that is not substitutable for what it decorates is not a decorator. Nothing downstream needs to know this happened.",
        "Everything the subject exposes and this does not wrap is *forwarded*, not copied. Copying it — spreading the subject into a new object — is the obvious version and it is wrong twice over: a spread takes own enumerable properties, so a class's prototype members and its getters above all are dropped silently, and a value copied once stops tracking a subject that changes afterwards. Reading a getter off a decorated object and finding `undefined` is a defect that reaches production, because nothing at the call site looks wrong.",
        "Forwarding also settles the `this` question. A getter reached through the forwarded property runs against the object that declared it, so one reading a `#private` field works; defining the property as a value read at wrap time would run it against the wrapper, which throws.",
        "`Reflect.apply(original, subject, …)` is the same decision for the wrapped methods. Calling `original(...)` bare would leave `this` undefined and break every class-based subject.",
      ],
      dedent`
      export function ${n.decorate}<Subject extends object>(
        subject: Subject,
        members: ${n.manifest}<Subject>,
        decoration: ${n.decoration}<Subject>,
      ): Subject {
        const source = subject as Record<string, unknown>;
        const wrapped: Record<string, unknown> = {};

        for (const name of memberNames(subject)) {
          if (Object.hasOwn(members, name)) continue;

          Object.defineProperty(wrapped, name, {
            configurable: true,
            enumerable: true,
            get: () => source[name],
            set: (value: unknown) => {
              source[name] = value;
            },
          });
        }

        for (const name of Object.keys(members)) {
          const member = name as ${n.methodKeys}<Subject> & string;
          const original = subject[member] as AnyMethod;

          wrapped[name] = (...args: never[]): unknown =>
            decoration({
              member,
              args: args as ArgsOf<Subject, typeof member>,
              proceed: (...passed: never[]): never =>
                Reflect.apply(original, subject, passed) as never,
            });
        }

        return wrapped as Subject;
      }
    `,
    ),
    documented(
      [
        "Every member the subject exposes, its own and its prototype's.",
        "The prototype walk is what makes a class subject work. `Object.keys` sees only own enumerable properties, which on a class instance is its fields and nothing else — no methods, no accessors — so a wrapper built from that would be missing most of the object.",
        "`Object.prototype` is where the walk stops, because forwarding `toString` and `hasOwnProperty` would shadow the wrapper's own with properties that read off the subject, to no purpose. `constructor` is skipped for the same reason.",
      ],
      dedent`
        function memberNames(subject: object): readonly string[] {
          const names = new Set<string>();

          for (
            let current: object | null = subject;
            current !== null && current !== Object.prototype;
            current = Object.getPrototypeOf(current) as object | null
          ) {
            for (const name of Object.getOwnPropertyNames(current)) {
              if (name !== "constructor") names.add(name);
            }
          }

          return [...names];
        }
      `,
    ),
  );
}

function layerFunction(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Several concerns around one subject, outermost first.",
      "`layer(timing, authorising)` puts timing outside authorising, so the timing sees the whole call including the refusal. Reading left to right as outermost to innermost is the order the equivalent nesting would be written in, and the order a stack trace shows.",
      "Each decoration receives the next as its `proceed`, so one that returns without calling it — a cache hit, a refusal — stops the chain there, and the ones further in never run. That is the behaviour that makes a stack worth having rather than a list of observers.",
      "Arguments are threaded through rather than captured: a decoration that changes them changes what the next one sees, which is the composition a caller would expect and the only version in which redaction works.",
      "The cast on the way out is the one place this file cannot be checked, and it is a limit of the language rather than a shortcut. A generic arrow function is not assignable to a generic function *type* without it, because the compiler will not verify that one body satisfies the signature for every `K` at once. The body is correct for each `K` — that is what the type parameter on it says — and the cast is what carries that from the body to the signature.",
    ],
    dedent`
      export function ${n.layer}<Subject extends object>(
        ...decorations: readonly ${n.decoration}<Subject>[]
      ): ${n.decoration}<Subject> {
        return (<K extends ${n.methodKeys}<Subject>>(call: ${n.call}<Subject, K>) => {
          const chained = decorations.reduceRight<${n.call}<Subject, K>>(
            (inner, decoration) => ({
              member: inner.member,
              args: inner.args,
              proceed: (...args) => decoration({ ...inner, args, proceed: inner.proceed }),
            }),
            call,
          );

          return chained.proceed(...call.args);
        }) as ${n.decoration}<Subject>;
      }
    `,
  );
}

/**
 * The example's wrapped ledger, as one expression.
 *
 * Assembled rather than written out four times: the entry point takes a manifest in one rendering and not
 * in the other, and the concern is one decoration or a stack of two, which is four combinations of the
 * same three lines. Prettier decides where it breaks.
 */
function appliedToLedger(shape: Shape): string {
  const n = shape.names;
  const decoration = shape.stacking
    ? `${n.layer}<Ledger>(timing(report), authorising(allowed))`
    : "timing(report)";
  const args = shape.proxied
    ? ["createLedger()", decoration]
    : ["createLedger()", "ledgerMethods", decoration];

  return `${n.decorate}(${args.join(", ")})`;
}

/**
 * The subject the example and the suite share.
 *
 * A ledger rather than a service or a repository: it has a synchronous method, an asynchronous one, a
 * method that returns nothing, and a non-callable member — which is the whole matrix this pattern has to
 * handle, in four members rather than a fixture someone has to read twice.
 */
function subjectDeclaration(): string {
  return dedent`
    interface Ledger {
      /** Not callable, and therefore not wrapped. A decorated ledger still has it. */
      readonly name: string;
      balance(account: string): number;
      post(account: string, cents: number): Promise<string>;
      close(): void;
    }
  `;
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  return sections(
    dedent`
      /**
       * Wrapping a ledger in the concerns that would otherwise be repeated in every method.
       *
       * The two decorations below are the two shapes worth seeing. \`timing\` observes and forwards, and has
       * to handle both a synchronous result and a promise to do it honestly. \`authorising\` refuses, which
       * is the case that shows why \`proceed\` is a call rather than a value: the method never runs.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.decorate, ...(shape.stacking ? [n.layer] : [])],
      // Not `OrderCall`: every decoration below takes its argument from the `OrderDecoration` it is
      // annotated with, so naming the call type would be an import the file does not use.
      types: [n.decoration, ...(shape.proxied ? [] : [n.manifest])],
    }),
    subjectDeclaration(),
    documented(
      [
        "The unwrapped ledger, which knows nothing about any of this.",
        "That it needs no change is the point of the pattern. A ledger that had to accept a logger, or extend a base class, would have the concern spread into it — which is the arrangement a decorator exists to avoid.",
      ],
      dedent`
        function createLedger(): Ledger {
          const balances = new Map<string, number>();

          return {
            name: "ledger",
            balance: (account) => balances.get(account) ?? 0,
            post: async (account, cents) => {
              balances.set(account, (balances.get(account) ?? 0) + cents);
              await Promise.resolve();
              return \`\${account}:\${String(cents)}\`;
            },
            close: () => {
              balances.clear();
            },
          };
        }
      `,
    ),
    documented(
      [
        "How long each call took, whether or not it returned a promise.",
        "The `instanceof Promise` branch is the part a timing wrapper usually gets wrong. Returning `proceed()` and recording immediately afterwards measures how long it took to *start* an async method, which for anything doing I/O is approximately zero — a number that looks plausible and is wrong.",
        "The cast on the awaited branch is unavoidable and worth understanding rather than hiding: inside a body generic in `K`, the compiler cannot see that a `Promise` result rewrapped in a promise is still `ResultOf<Subject, K>`. The alternative is a decoration typed per method, which is the repetition the pattern removes.",
      ],
      dedent`
        function timing(report: (line: string) => void): ${n.decoration}<Ledger> {
          return (call) => {
            const started = Date.now();
            const finish = (): void => {
              report(\`\${String(call.member)} took \${String(Date.now() - started)}ms\`);
            };

            const result = call.proceed(...call.args);

            if (result instanceof Promise) {
              return result.finally(finish) as typeof result;
            }

            finish();
            return result;
          };
        }
      `,
    ),
    documented(
      [
        "Refusing the calls that change something.",
        "A concern that decides per method, which is what `member` being a literal union is for: naming a method the ledger does not have is a compile error here rather than a rule that silently stops applying.",
        "`never` as the return type of the throwing branch is what lets one arm of the decision refuse while the other returns each method's own result.",
      ],
      dedent`
        function authorising(allowed: () => boolean): ${n.decoration}<Ledger> {
          return (call) => {
            if ((call.member === "post" || call.member === "close") && !allowed()) {
              throw new Error(\`\${String(call.member)} is not permitted\`);
            }

            return call.proceed(...call.args);
          };
        }
      `,
    ),
    when(
      !shape.proxied,
      documented(
        [
          "Every method of the ledger, named once.",
          "Adding a method to `Ledger` makes this a compile error naming it, which is the guarantee the manifest buys. A caller who wants the new method left alone says so in the decoration rather than by leaving it out here.",
        ],
        dedent`
          const ledgerMethods: ${n.manifest}<Ledger> = {
            balance: true,
            post: true,
            close: true,
          };
        `,
      ),
    ),
    documented(
      [
        shape.stacking
          ? "The ledger a caller actually uses."
          : "The ledger a caller actually uses, with the one concern applied.",
        shape.stacking
          ? "Timing outside authorisation, so a refused call is still timed and still reported. The other order would leave a refusal invisible to whatever reads the timings — which is usually the thing being asked why the numbers do not add up."
          : "One decoration, applied directly. Stacking is what `stacking: true` emits, and a second concern here would otherwise have to be written as a decoration that calls another by hand.",
      ],
      dedent`
        export function auditedLedger(
          report: (line: string) => void,
          allowed: () => boolean,
        ): Ledger {
          return ${appliedToLedger(shape)};
        }
      `,
    ),
    documented(
      [
        "What the wrapping does not change.",
        "The decorated ledger is a `Ledger`, so this function does not know or care whether it was given a bare one. That substitutability is the property worth demonstrating in the example rather than only asserting in the suite.",
      ],
      dedent`
        export async function settle(ledger: Ledger, account: string): Promise<string> {
          const before = ledger.balance(account);
          const receipt = await ledger.post(account, 100);
          return \`\${ledger.name}: \${String(before)} -> \${receipt}\`;
        }
      `,
    ),
    when(
      shape.proxied,
      documented(
        [
          "What a proxy will and will not notice.",
          "A property whose value is a function cannot be told apart from a method at run time, so it is wrapped too. Worth knowing before choosing this dispatch; the manifest rendering does not have the ambiguity because the list is typed against the methods.",
        ],
        dedent`
          export function passesThroughData(ledger: Ledger): string {
            // Not callable, so the proxy hands it back untouched.
            return ledger.name;
          }
        `,
      ),
    ),
  );
}

function tests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  const framework =
    conventions.testFramework === "node-test"
      ? joinLines(
          importsFrom(conventions, "node:test", { values: ["describe", "it"] }),
          importsFrom(conventions, siblingSpecifier(conventions, "expect"), {
            values: ["expect"],
          }),
        )
      : importsFrom(
          conventions,
          "vitest",
          {
            values: ["describe", "expect", "it"],
          },
        );

  return sections(
    dedent`
      /**
       * What is asserted here, and why.
       *
       * The cases are the four things that separate a decorator from a wrapper someone wrote in a hurry:
       * that every method is reached, that the ones that are not methods are left alone, that \`this\` and
       * the return values survive, and that a failure is not swallowed on the way out.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.decorate, ...(shape.stacking ? [n.layer] : [])],
      types: [n.decoration, ...(shape.proxied ? [] : [n.manifest])],
    }),
    fixtures(shape),
    describeBlocks(shape),
  );
}

function fixtures(shape: Shape): string {
  const n = shape.names;

  return sections(
    dedent`
      /**
       * A class rather than an object literal, and for one reason: private state reached through \`this\`.
       *
       * An object literal subject would pass even if the wrapping lost its receiver, so it would not
       * notice the mistake that breaks every real subject. The getter is here for the same reason — it is
       * what fails when a proxy binds \`this\` to itself instead of to the target.
       */
      class Counter {
        #count = 0;
        readonly label = "counter";

        get seen(): number {
          return this.#count;
        }

        bump(by: number): number {
          this.#count += by;
          return this.#count;
        }

        async settle(): Promise<string> {
          await Promise.resolve();
          return \`at \${String(this.#count)}\`;
        }

        fail(): never {
          throw new Error("boom");
        }
      }
    `,
    when(
      !shape.proxied,
      dedent`
        const counterMethods: ${n.manifest}<Counter> = {
          bump: true,
          settle: true,
          fail: true,
        };
      `,
    ),
    documented(
      [
        "One subject and one recorder, so a case can assert what the concern saw.",
        "Returned together because every case needs both, and a suite that reached for a shared mutable array would have its cases depend on the order they run in.",
      ],
      dedent`
        function build(
          decoration: (trace: string[]) => ${n.decoration}<Counter>,
        ): { readonly counter: Counter; readonly trace: string[] } {
          const trace: string[] = [];
          const counter = ${call(shape, "new Counter()", "decoration(trace)")};
          return { counter, trace };
        }
      `,
    ),
    documented(
      ["A decoration that only watches, which is what most of the cases need."],
      dedent`
        function watching(trace: string[]): ${n.decoration}<Counter> {
          return (call) => {
            trace.push(String(call.member));
            return call.proceed(...call.args);
          };
        }
      `,
    ),
  );
}

/** A call to the entry point, which takes a manifest only in the manifest rendering. */
function call(
  shape: Shape,
  subject: string,
  decoration: string,
  manifest = "counterMethods",
): string {
  const args = shape.proxied
    ? [subject, decoration]
    : [subject, manifest, decoration];
  return `${shape.names.decorate}(${args.join(", ")})`;
}

function stackingCases(shape: Shape): string {
  const n = shape.names;
  const layered = (inner: string): string =>
    call(shape, "new Counter()", `${n.layer}<Counter>(${inner})`);

  return dedent`
    describe("${n.layer}", () => {
      it("applies decorations outermost first", () => {
        const trace: string[] = [];
        const tag =
          (name: string): ${n.decoration}<Counter> =>
          (call) => {
            trace.push(\`\${name}:in\`);
            const result = call.proceed(...call.args);
            trace.push(\`\${name}:out\`);
            return result;
          };

        const counter = ${layered('tag("outer"), tag("inner")')};
        counter.bump(1);

        expect(trace).toEqual(["outer:in", "inner:in", "inner:out", "outer:out"]);
      });

      it("stops at a decoration that does not proceed", () => {
        const reached: string[] = [];
        // Answers with a number without proceeding, which is what a cache hit looks like.
        const refusing: ${n.decoration}<Counter> = () => 0 as never;
        const inner: ${n.decoration}<Counter> = (call) => {
          reached.push(String(call.member));
          return call.proceed(...call.args);
        };

        const counter = ${layered("refusing, inner")};

        expect(counter.bump(9)).toBe(0);
        expect(reached).toEqual([]);
      });

      it("threads changed arguments through to the subject", () => {
        const doubling: ${n.decoration}<Counter> = (call) =>
          call.member === "bump"
            ? call.proceed(...([(call.args[0] as number) * 2] as typeof call.args))
            : call.proceed(...call.args);

        const counter = ${layered("doubling")};

        expect(counter.bump(3)).toBe(6);
      });
    });
  `;
}

function describeBlocks(shape: Shape): string {
  const n = shape.names;

  return sections(
    dedent`
      describe("${n.decorate}", () => {
        it("reaches every method", async () => {
          const { counter, trace } = build(watching);

          counter.bump(1);
          await counter.settle();

          expect(trace).toEqual(["bump", "settle"]);
        });

        it("keeps the subject's return values", async () => {
          const { counter } = build(watching);

          // Two calls, so the second proves the first mutated the subject and not a copy of it.
          expect(counter.bump(2)).toBe(2);
          expect(counter.bump(3)).toBe(5);
          expect(await counter.settle()).toBe("at 5");
        });

        it("keeps \`this\` bound to the subject", () => {
          // The assertion is that this does not throw. \`bump\` and \`seen\` both read a private field, so
          // a wrapping that lost its receiver fails here rather than returning a wrong number.
          const { counter } = build(watching);

          counter.bump(4);
          expect(counter.seen).toBe(4);
        });

        it("leaves the members that are not methods alone", () => {
          const { counter, trace } = build(watching);

          expect(counter.label).toBe("counter");
          expect(trace).toEqual([]);
        });

        it("does not swallow a failure", () => {
          const { counter, trace } = build(watching);

          expect(() => counter.fail()).toThrow(/boom/);
          // Seen by the concern on its way in, and still thrown on its way out.
          expect(trace).toEqual(["fail"]);
        });

        it("lets a decoration answer without calling the method", async () => {
          const { counter } = build(
            () => (call) => (call.member === "settle" ? ("cached" as never) : call.proceed(...call.args)),
          );

          expect(await counter.settle()).toBe("cached");
          // The method never ran, so the count it would have reported is untouched.
          expect(counter.bump(0)).toBe(0);
        });
      });
    `,
    when(shape.stacking, stackingCases(shape)),
  );
}
