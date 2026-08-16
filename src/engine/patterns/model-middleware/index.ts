/**
 * The `model-middleware` pattern: layers between a caller and a chat model, invisible from both sides.
 *
 * Four decisions, each settled with the compiler before the templates were written.
 *
 * **The request is declared in full and the answer is not.** A layer changes requests, so it needs the
 * real message union: a layer that could fabricate a `{ role: "user" }` with no content would compile and
 * produce a body the provider rejects. A layer only ever passes an answer along, so the answer is a type
 * parameter bounded by the one field anything reads — which is what keeps a wrapped model *the port's*
 * model rather than a lookalike that has lost `content`.
 *
 * **A layer declared over that bound collapses the answer for the whole chain, silently.** `wrapModel`
 * infers its answer from two places, the model and the list, and a `Middleware<MinimalAnswer>` in the list
 * wins — after which every caller of the wrapped model has an answer with nothing on it but `usage`, and
 * nothing anywhere reports a problem. So every layer here is generic in the answer, and `wrapModel` takes
 * its list as `NoInfer<…>`, which turns a caller's non-generic layer into an error at the call site naming
 * the fields it would have lost. Both halves of that were checked: without the layers being generic,
 * inference collapses; without `NoInfer`, it collapses quietly.
 *
 * **The port's tool-name checking survives wrapping.** `generate` is generic in a `const` type parameter,
 * so `toolChoice: { mode: "tool", toolName: … }` is checked against the names the request declared. The
 * wrapper keeps that signature and implements it over one widened request, which works because the request
 * type is covariant in its tools. Written the obvious way — a single non-generic request — the wrapper
 * still typechecks and the guarantee is gone, so the emitted `*.test-d.ts` pins it.
 *
 * **No per-call context.** A wrapping hook has both halves of a call in one closure, so the correlation id
 * a middleware stack usually needs a context for is a local variable here.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { expectFileEntry, frameworkImports } from "../expect-file.js";
import {
  BLANK,
  codeLines,
  dedent,
  doc,
  documented,
  sections,
  when,
} from "../../render/helpers.js";
import { TYPE_TEST_SUFFIX, typeAssertKit } from "../type-assert-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

const STEM = "model-middleware";

export const modelMiddlewarePattern: PatternModule = {
  name: "model-middleware",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      streaming: options.streaming !== false,
      caching: options.caching !== false,
      fallback: options.fallback !== false,
    };

    const files: RenderedFile[] = [
      { path: `${STEM}.ts`, role: "core", contents: core(shape) },
      {
        path: `${STEM}-example.ts`,
        role: "example",
        contents: example(context, shape),
      },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({
        path: `${STEM}${TYPE_TEST_SUFFIX}`,
        role: "test",
        contents: typeTests(context, shape),
      });
      files.push({
        path: `${STEM}.test.ts`,
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
  /** `streaming: true` — the seam covers `stream`, and a layer can wrap one. */
  readonly streaming: boolean;
  /** `caching: true` — the caching layer and its store. */
  readonly caching: boolean;
  /** `fallback: true` — the layer that sends a failed request to a second model. */
  readonly fallback: boolean;
}

/** The type parameters every layer factory carries, and the reason it has to. */
function layerParams(shape: Shape): string {
  return shape.streaming
    ? "<Answer extends MinimalAnswer = MinimalAnswer, Part extends MinimalPart = MinimalPart>"
    : "<Answer extends MinimalAnswer = MinimalAnswer>";
}

/** `Middleware<Answer, Part>`, or without the part when there are no streams. */
function layerType(shape: Shape): string {
  return shape.streaming ? "Middleware<Answer, Part>" : "Middleware<Answer>";
}

/** The model type a layer or the wrapper deals in. */
function modelType(shape: Shape): string {
  return shape.streaming ? "StreamingModel<Answer, Part>" : "Model<Answer>";
}

// ---------------------------------------------------------------------------------------------------
// The core.
// ---------------------------------------------------------------------------------------------------

function core(shape: Shape): string {
  return sections(
    coreHeader(shape),
    seamTypes(shape),
    modelTypes(shape),
    middlewareType(shape),
    wrapping(shape),
    chaining(shape),
    defaultsLayer(shape),
    telemetryLayer(shape),
    when(shape.caching, cacheLayer(shape)),
    when(shape.fallback, fallbackLayer(shape)),
  );
}

function coreHeader(shape: Shape): string {
  return doc(
    "Layers between a caller and a chat model.",
    "`wrapModel` returns a model of the same type it was given, so a layer is invisible from both sides: the caller calls what it always called, the provider receives what it always received, and everything in between — the settings a request should have, what a call cost, whether it has been asked before — lives in one place instead of in the code that happens to be calling the model.",
    "Nothing here is imported. The model arrives through the interface below, which the chat-model port's own model satisfies as it stands, and a wrapped model satisfies the port in turn — both checked with the compiler, since a wrapper that is *nearly* the thing it wraps is worse than no wrapper.",
    "The answer is a type parameter rather than a declared shape, because a layer passes one along rather than reading it. That is what stops a wrapped model from returning less than the model did, and it is why every layer here is generic in the answer: one that is not collapses the answer for the whole chain, which the type-level suite states outright.",
    shape.streaming
      ? "`stream` is covered as well as `generate`, and the two are separate hooks on purpose. A layer that wraps one and not the other applies to one and not the other — the types permit it and nothing at run time complains, so a cache written over `generate` alone is simply absent the day a caller switches to streaming. Naming both hooks makes that a decision instead of an accident."
      : "Only `generate` is covered. A model with a `stream` this does not wrap is a model half of whose calls would go past every layer, so the seam does not describe one.",
  );
}

function seamTypes(shape: Shape): string {
  return sections(
    doc(
      "The conversation and the request, exactly as the port has them.",
      "Declared in full rather than reduced to the fields a layer reads, and that asymmetry with the answer below is deliberate. A layer *writes* requests, so it needs to be able to build a message the provider will accept; a shorter declaration — a message as `{ role: string }`, say — accepts everything the port sends and also lets a layer invent one with no content, which typechecks and fails on the wire.",
    ),
    documented(
      ["A schema as the wire carries it: a JSON Schema object, unexamined."],
      "export type JsonSchema = Readonly<Record<string, unknown>>;",
    ),
    documented(
      ["A run of text."],
      dedent`
        export interface TextPart {
          readonly type: "text";
          readonly text: string;
        }
      `,
    ),
    documented(
      ["The model asking for a tool to be run."],
      dedent`
        export interface ToolCallPart {
          readonly type: "tool-call";
          readonly callId: string;
          readonly toolName: string;
          readonly input: unknown;
        }
      `,
    ),
    documented(
      ["What running one produced."],
      dedent`
        export interface ToolResultPart {
          readonly type: "tool-result";
          readonly callId: string;
          readonly toolName: string;
          readonly output: unknown;
          readonly failed?: boolean;
        }
      `,
    ),
    documented(
      [
        "The conversation, as three roles.",
        "There is no `system` role: the system prompt is a field on the request, because only one of the two mainstream wire formats can place one mid-conversation.",
      ],
      dedent`
        export interface UserMessage {
          readonly role: "user";
          readonly content: readonly TextPart[];
        }

        export interface AssistantMessage {
          readonly role: "assistant";
          readonly content: readonly (TextPart | ToolCallPart)[];
        }

        export interface ToolMessage {
          readonly role: "tool";
          readonly content: readonly ToolResultPart[];
        }

        export type Message = UserMessage | AssistantMessage | ToolMessage;
      `,
    ),
    documented(
      ["A tool the model may ask to have run."],
      dedent`
        export interface ToolDefinition {
          readonly name: string;
          readonly description?: string;
          readonly inputSchema: JsonSchema;
        }
      `,
    ),
    documented(
      [
        "The names a request declared, as a union of string literals.",
        "`never` for an empty tuple, which is what makes naming a tool when none were declared a compile error rather than a request the provider rejects.",
      ],
      'export type ToolNamesOf<Tools extends readonly ToolDefinition[]> = Tools[number]["name"];',
    ),
    documented(
      [
        "Whether the model may use a tool, must use one, or must use a particular one.",
      ],
      dedent`
        export type ToolChoice<Names extends string> =
          | { readonly mode: "auto" }
          | { readonly mode: "none" }
          | { readonly mode: "required" }
          | { readonly mode: "tool"; readonly toolName: Names };
      `,
    ),
    documented(
      [
        "One turn's worth of input.",
        '`Tools` defaults to the empty tuple rather than to `readonly ToolDefinition[]`, which is what makes `toolChoice: { mode: "tool", … }` unusable on a request that declared no tools. That guarantee is the one a wrapper is most likely to lose, and the type-level suite is where it is held to.',
      ],
      dedent`
        export interface ChatRequest<Tools extends readonly ToolDefinition[] = readonly []> {
          readonly messages: readonly Message[];
          readonly system?: string;
          readonly tools?: Tools;
          readonly toolChoice?: ToolChoice<ToolNamesOf<Tools>>;
          readonly maxOutputTokens?: number;
          readonly temperature?: number;
          readonly stopSequences?: readonly string[];
          readonly signal?: AbortSignal;
          /** Merged into the request body verbatim. Whatever this seam does not describe goes here. */
          readonly providerOptions?: Readonly<Record<string, unknown>>;
        }
      `,
    ),
    documented(
      [
        "The request a layer sees: any request at all, with its tool names widened to `string`.",
        "A layer cannot be generic in the caller's tools — it was written before the caller existed — so it deals in the widest request there is. Every `ChatRequest<Tools>` is one of these, because the request type is covariant in its tools, which is exactly what lets the wrapper keep the narrow signature outside while running the wide one inside.",
      ],
      "export type AnyRequest = ChatRequest<readonly ToolDefinition[]>;",
    ),
    documented(
      [
        "Tokens in and out, where the provider reported them.",
        "Both fields are present and possibly `undefined` rather than optional, so that reading one is a check for `undefined` rather than a check for a missing property.",
      ],
      dedent`
        export interface Usage {
          readonly inputTokens: number | undefined;
          readonly outputTokens: number | undefined;
        }
      `,
    ),
    documented(
      [
        "What a layer reads of an answer, and therefore all it requires one to have.",
        "The bound rather than the shape. A layer here reports on an answer and hands it back untouched, so requiring anything more of it would mean a wrapped model returning this instead of whatever the model returns — and a caller losing every field the provider sent.",
      ],
      dedent`
        export interface MinimalAnswer {
          readonly usage: Usage;
        }
      `,
    ),
    when(
      shape.streaming,
      documented(
        [
          "What a layer reads of a stream part.",
          "`usage` is optional because only the last part of a stream carries one, and `type` is a `string` rather than a union because a layer does not decide what the parts are.",
        ],
        dedent`
          export interface MinimalPart {
            readonly type: string;
            readonly usage?: Usage;
          }
        `,
      ),
    ),
  );
}

function modelTypes(shape: Shape): string {
  return sections(
    documented(
      [
        "The model, as narrowly as this pattern needs it.",
        "`generate` is a method rather than a function property so that it is checked bivariantly: a model written against a request type that is compatible without being identical still satisfies this, which is what lets the chat-model port's own model arrive here unchanged.",
        "`Answer` is inferred from whatever is passed in, so a wrapped model returns what the model returned.",
      ],
      dedent`
        export interface Model<Answer extends MinimalAnswer = MinimalAnswer> {
          /** What this model was constructed for. A wrapped model reports the same one. */
          readonly modelId: string;
          generate<const Tools extends readonly ToolDefinition[] = readonly []>(
            request: ChatRequest<Tools>,
          ): Promise<Answer>;
        }
      `,
    ),
    when(
      shape.streaming,
      documented(
        [
          "A model that can also stream.",
          "`stream` returns an `AsyncIterable` rather than a promise of one, which is what lets a caller write `for await` on the result directly — and which the wrapper has to preserve: the request is not sent until the first value is asked for, even when a layer's request transform is asynchronous.",
        ],
        dedent`
          export interface StreamingModel<
            Answer extends MinimalAnswer = MinimalAnswer,
            Part extends MinimalPart = MinimalPart,
          > extends Model<Answer> {
            stream<const Tools extends readonly ToolDefinition[] = readonly []>(
              request: ChatRequest<Tools>,
            ): AsyncIterable<Part>;
          }
        `,
      ),
    ),
  );
}

function middlewareType(shape: Shape): string {
  return sections(
    documented(
      [
        "One layer.",
        "Three hooks, all optional, and the split between them is the whole design. `transformRequest` is for a layer that only wants to change what is sent: it applies to every kind of call, so a layer that shapes requests cannot be accidentally absent from one of them." +
          (shape.streaming
            ? " `wrapGenerate` and `wrapStream` are for a layer that wants to be around the call — to time it, to answer it from somewhere else, to catch what it threw — and there are two of them because a layer that wraps a waited-for call has said nothing about a streamed one. Writing only `wrapGenerate` is allowed and sometimes right; it is never *invisibly* right, because the hook it did not write is named here."
            : ""),
        "`name` is not used to look a layer up. It is there so that a chain can be printed, which is the first thing anybody wants when a request arrives at the provider looking unlike the one they sent.",
        "Every layer factory below is generic in `Answer`" +
          (shape.streaming ? " and `Part`" : "") +
          ", and yours has to be too: a layer declared over `MinimalAnswer` collapses the answer type for the whole chain. `wrapModel` refuses one rather than accepting it quietly.",
      ],
      shape.streaming
        ? dedent`
            export interface Middleware<
              Answer extends MinimalAnswer = MinimalAnswer,
              Part extends MinimalPart = MinimalPart,
            > {
              readonly name: string;
              readonly transformRequest?: (request: AnyRequest) => AnyRequest | Promise<AnyRequest>;
              readonly wrapGenerate?: (
                request: AnyRequest,
                next: (request: AnyRequest) => Promise<Answer>,
              ) => Promise<Answer>;
              readonly wrapStream?: (
                request: AnyRequest,
                next: (request: AnyRequest) => AsyncIterable<Part>,
              ) => AsyncIterable<Part>;
            }
          `
        : dedent`
            export interface Middleware<Answer extends MinimalAnswer = MinimalAnswer> {
              readonly name: string;
              readonly transformRequest?: (request: AnyRequest) => AnyRequest | Promise<AnyRequest>;
              readonly wrapGenerate?: (
                request: AnyRequest,
                next: (request: AnyRequest) => Promise<Answer>,
              ) => Promise<Answer>;
            }
          `,
    ),
  );
}

function wrapping(shape: Shape): string {
  const parts = shape.streaming ? ", Part extends MinimalPart" : "";

  return sections(
    documented(
      [
        "A model with the layers around it.",
        "The first layer in the list is the outermost: it sees a request before any other and an answer after all of them. That is the order every middleware stack uses, and the emitted suite pins both halves of it, because a chain that composes in the wrong direction still works for one layer.",
        "`NoInfer` on the list is what makes a non-generic layer an error here rather than a surprise later. Without it the answer type is inferred from the layers as well as from the model, and the narrowest thing wins.",
        "The returned model is a new object rather than the given one with properties replaced, so wrapping a model twice cannot leave the first wrapper's hooks attached to the second's.",
      ],
      codeLines(
        `export function wrapModel<Answer extends MinimalAnswer${parts}>(`,
        `  model: ${modelType(shape)},`,
        `  middlewares: readonly NoInfer<${layerType(shape)}>[],`,
        `): ${modelType(shape)} {`,
        "  const generateThrough = generateChain(model, middlewares);",
        ...(shape.streaming
          ? ["  const streamThrough = streamChain(model, middlewares);"]
          : []),
        BLANK,
        "  return {",
        "    modelId: model.modelId,",
        BLANK,
        "    generate<const Tools extends readonly ToolDefinition[] = readonly []>(",
        "      request: ChatRequest<Tools>,",
        "    ): Promise<Answer> {",
        "      return generateThrough(request);",
        "    },",
        ...(shape.streaming
          ? [
              BLANK,
              "    stream<const Tools extends readonly ToolDefinition[] = readonly []>(",
              "      request: ChatRequest<Tools>,",
              "    ): AsyncIterable<Part> {",
              "      return streamThrough(request);",
              "    },",
            ]
          : []),
        "  };",
        "}",
      ),
    ),
  );
}

function chaining(shape: Shape): string {
  const parts = shape.streaming ? ", Part extends MinimalPart" : "";

  return sections(
    documented(
      [
        "The layers folded into one call.",
        "Built from the innermost outwards, which is why the list is walked backwards: each turn wraps what has been built so far, so the layer visited last — the one the caller listed first — ends up outermost.",
        "A layer's own request transform runs before its own wrapper, so a layer that changes a request sees the changed one. What the next layer sees is whatever this one passed to `next`, which is what makes a layer able to hide a change from the layers below it.",
      ],
      codeLines(
        `function generateChain<Answer extends MinimalAnswer${parts}>(`,
        `  model: ${modelType(shape)},`,
        `  middlewares: readonly ${layerType(shape)}[],`,
        "): (request: AnyRequest) => Promise<Answer> {",
        "  let call = (request: AnyRequest): Promise<Answer> => model.generate(request);",
        BLANK,
        "  for (const middleware of [...middlewares].reverse()) {",
        "    const inner = call;",
        "    const { transformRequest, wrapGenerate } = middleware;",
        BLANK,
        "    call = async (request: AnyRequest): Promise<Answer> => {",
        "      const shaped = transformRequest === undefined ? request : await transformRequest(request);",
        BLANK,
        "      return wrapGenerate === undefined ? inner(shaped) : wrapGenerate(shaped, inner);",
        "    };",
        "  }",
        BLANK,
        "  return call;",
        "}",
      ),
    ),
    when(
      shape.streaming,
      documented(
        [
          "The same fold, for a stream.",
          "Each stage is an async generator rather than an async function, and that is the load-bearing detail: nothing in the body runs until the first value is asked for, so a layer whose request transform is asynchronous does not turn `stream` into something that has already sent the request by the time it returns. An implementation that awaited the transform outside the generator would compile and would send every request one call too early.",
        ],
        codeLines(
          "function streamChain<Answer extends MinimalAnswer, Part extends MinimalPart>(",
          "  model: StreamingModel<Answer, Part>,",
          "  middlewares: readonly Middleware<Answer, Part>[],",
          "): (request: AnyRequest) => AsyncIterable<Part> {",
          "  let call = (request: AnyRequest): AsyncIterable<Part> => model.stream(request);",
          BLANK,
          "  for (const middleware of [...middlewares].reverse()) {",
          "    const inner = call;",
          "    const { transformRequest, wrapStream } = middleware;",
          BLANK,
          "    call = (request: AnyRequest): AsyncIterable<Part> =>",
          "      (async function* through(): AsyncIterable<Part> {",
          "        const shaped = transformRequest === undefined ? request : await transformRequest(request);",
          BLANK,
          "        yield* wrapStream === undefined ? inner(shaped) : wrapStream(shaped, inner);",
          "      })();",
          "  }",
          BLANK,
          "  return call;",
          "}",
        ),
      ),
    ),
  );
}

function defaultsLayer(shape: Shape): string {
  return sections(
    documented(
      ["Settings a request gets when it did not bring its own."],
      dedent`
        export interface Defaults {
          readonly system?: string;
          readonly temperature?: number;
          readonly maxOutputTokens?: number;
        }
      `,
    ),
    documented(
      [
        "The layer that applies them.",
        "A request transform and nothing else, so it applies to every kind of call.",
        "`??` rather than `||`, which matters for exactly one value and it is the important one: `temperature: 0` is what a caller sets to make a model repeatable, and `||` would throw it away and substitute the default.",
        "Each field is written only when there is something to write, because under `exactOptionalPropertyTypes` an optional field cannot be set to `undefined` — and because a request carrying `temperature: undefined` is not the same thing to a provider as one that never mentioned it.",
      ],
      codeLines(
        `export function withDefaults${layerParams(shape)}(`,
        "  defaults: Defaults,",
        `): ${layerType(shape)} {`,
        "  return {",
        '    name: "defaults",',
        "    transformRequest: (request: AnyRequest): AnyRequest => {",
        "      const system = request.system ?? defaults.system;",
        "      const temperature = request.temperature ?? defaults.temperature;",
        "      const maxOutputTokens = request.maxOutputTokens ?? defaults.maxOutputTokens;",
        BLANK,
        "      return {",
        "        ...request,",
        "        ...(system === undefined ? {} : { system }),",
        "        ...(temperature === undefined ? {} : { temperature }),",
        "        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),",
        "      };",
        "    },",
        "  };",
        "}",
      ),
    ),
  );
}

function telemetryLayer(shape: Shape): string {
  return sections(
    documented(
      [
        "What one call cost and how long it took.",
        "The report carries the request rather than a summary of it, because what is worth recording differs per caller — the number of messages, the tools offered, a header out of `providerOptions` — and a layer that decided for them would be replaced by a hand-written one on its first day.",
        "There is no model id in the report. A chain can end at more than one model" +
          (shape.fallback ? ", which is the fallback layer's business" : "") +
          ", so a layer positioned above that cannot honestly name which one answered; a caller who wants it names it when they build the layer.",
      ],
      codeLines(
        "export interface CallReport {",
        ...(shape.streaming
          ? [
              "  /** Which of the two kinds of call this was. */",
              '  readonly kind: "generate" | "stream";',
            ]
          : []),
        "  readonly request: AnyRequest;",
        "  readonly milliseconds: number;",
        '  readonly outcome: "answered" | "failed";',
        "  /** What the provider reported, when it answered. */",
        "  readonly usage: Usage | undefined;",
        "  /** What it threw, when it did not. */",
        "  readonly failure: unknown;",
        "}",
      ),
    ),
    documented(
      [
        "Where the reports go, and what the clock is.",
        "`now` is injectable so a suite can pin a duration. Without it a test can only assert that the number is a number, which is also true of a negative one.",
      ],
      dedent`
        export interface TelemetryOptions {
          readonly report: (call: CallReport) => void;
          /** Defaults to \`Date.now\`. */
          readonly now?: () => number;
        }
      `,
    ),
    documented(
      [
        "The layer that reports them.",
        "Nothing is swallowed: a failure is reported and then rethrown, because a layer that observes is not a layer that decides." +
          (shape.streaming
            ? " A stream is reported once it has finished, which means an abandoned one is not reported at all — half a latency figure is worse than none."
            : ""),
      ],
      codeLines(
        `export function withTelemetry${layerParams(shape)}(`,
        "  options: TelemetryOptions,",
        `): ${layerType(shape)} {`,
        "  const now = options.now ?? ((): number => Date.now());",
        BLANK,
        "  return {",
        '    name: "telemetry",',
        BLANK,
        "    wrapGenerate: async (request: AnyRequest, next): Promise<Answer> => {",
        "      const started = now();",
        BLANK,
        "      try {",
        "        const answer = await next(request);",
        BLANK,
        "        options.report({",
        ...(shape.streaming ? ['          kind: "generate",'] : []),
        "          request,",
        "          milliseconds: now() - started,",
        '          outcome: "answered",',
        "          usage: answer.usage,",
        "          failure: undefined,",
        "        });",
        BLANK,
        "        return answer;",
        "      } catch (failure) {",
        "        options.report({",
        ...(shape.streaming ? ['          kind: "generate",'] : []),
        "          request,",
        "          milliseconds: now() - started,",
        '          outcome: "failed",',
        "          usage: undefined,",
        "          failure,",
        "        });",
        BLANK,
        "        // Rethrown rather than reported and swallowed. A layer that observes is not a layer that",
        "        // decides, and a caller whose call failed has to hear about it from the call.",
        "        throw failure;",
        "      }",
        "    },",
        ...(shape.streaming
          ? [
              BLANK,
              "    wrapStream: (request: AnyRequest, next): AsyncIterable<Part> =>",
              "      (async function* through(): AsyncIterable<Part> {",
              "        const started = now();",
              "        // The usage of a stream is on its last part, so this is read as the parts go past",
              "        // rather than looked for at the end, where the part carrying it is already gone.",
              "        let usage: Usage | undefined = undefined;",
              BLANK,
              "        try {",
              "          for await (const part of next(request)) {",
              "            usage = part.usage ?? usage;",
              "            yield part;",
              "          }",
              "        } catch (failure) {",
              "          options.report({",
              '            kind: "stream",',
              "            request,",
              "            milliseconds: now() - started,",
              '            outcome: "failed",',
              "            usage,",
              "            failure,",
              "          });",
              BLANK,
              "          throw failure;",
              "        }",
              BLANK,
              "        // After the loop rather than in a `finally`, so a stream the caller abandoned",
              "        // half-way is not reported as one that finished.",
              "        options.report({",
              '          kind: "stream",',
              "          request,",
              "          milliseconds: now() - started,",
              '          outcome: "answered",',
              "          usage,",
              "          failure: undefined,",
              "        });",
              "      })(),",
            ]
          : []),
        "  };",
        "}",
      ),
    ),
  );
}

function cacheLayer(shape: Shape): string {
  const entry = shape.streaming
    ? "CacheEntry<Answer, Part>"
    : "CacheEntry<Answer>";
  const storeType = shape.streaming
    ? "CacheStore<Answer, Part>"
    : "CacheStore<Answer>";
  const optionsType = shape.streaming
    ? "CacheOptions<Answer, Part>"
    : "CacheOptions<Answer>";
  const storeParams = shape.streaming
    ? "<Answer extends MinimalAnswer, Part extends MinimalPart>"
    : "<Answer extends MinimalAnswer>";

  return sections(
    documented(
      [
        "An answer the model has already given.",
        shape.streaming
          ? "Two kinds, because a stream is not an answer. An `AsyncIterable` can be consumed once, so handing the same one back a second time yields nothing at all — the parts are kept and a fresh iteration over them is what a hit replays."
          : "One kind, and it is the answer as the model gave it.",
      ],
      shape.streaming
        ? dedent`
            export type CacheEntry<Answer extends MinimalAnswer, Part extends MinimalPart> =
              | { readonly kind: "answer"; readonly answer: Answer }
              | { readonly kind: "parts"; readonly parts: readonly Part[] };
          `
        : dedent`
            export interface CacheEntry<Answer extends MinimalAnswer> {
              readonly answer: Answer;
            }
          `,
    ),
    documented(
      [
        "Where the entries live.",
        "Both methods may return a promise, because the useful stores are out of process. A synchronous-only interface is the kind that gets abandoned the first time somebody points it at Redis, and awaiting a value that was never a promise costs a microtask.",
      ],
      codeLines(
        `export interface CacheStore${storeParams} {`,
        `  get(key: string): ${entry} | undefined | Promise<${entry} | undefined>;`,
        `  set(key: string, entry: ${entry}): void | Promise<void>;`,
        "}",
      ),
    ),
    documented(
      [
        "A store in a `Map`, which is what a development loop wants and what nothing else should use.",
      ],
      codeLines(
        `export function memoryStore${storeParams}(): ${storeType} {`,
        `  const entries = new Map<string, ${entry}>();`,
        BLANK,
        "  return {",
        `    get: (key: string): ${entry} | undefined => entries.get(key),`,
        `    set: (key: string, entry: ${entry}): void => {`,
        "      entries.set(key, entry);",
        "    },",
        "  };",
        "}",
      ),
    ),
    documented(
      [
        "Answering from what the model said last time.",
        "`cacheable` is the part worth reading before using this. A model asked at a temperature above zero is being asked for a different answer each time, and serving the first one forever is not a cache but a bug — so the default is to cache a request only when it says `temperature: 0`. An *unset* temperature is not the same thing: the mainstream providers default it to one, so a request that never mentioned it is a sample of a distribution and is deliberately not cached. A development loop that wants everything cached anyway says `cacheable: () => true` and knows what it asked for.",
      ],
      codeLines(
        `export interface CacheOptions${storeParams} {`,
        `  readonly store?: ${storeType};`,
        "  /**",
        "   * What to put in front of every key, for a store more than one model writes to.",
        "   * Nothing in a request says which model it was going to be sent to — this layer sits above",
        "   * that choice" +
          (shape.fallback ? ", and under a fallback there are two of them" : "") +
          " — so two models sharing a store and no namespace answer for each other.",
        "   */",
        "  readonly namespace?: string;",
        "  readonly keyOf?: (request: AnyRequest) => string;",
        "  readonly cacheable?: (request: AnyRequest) => boolean;",
        "}",
      ),
    ),
    documented(
      [
        "The layer that answers from it.",
        "A miss stores what the model said" +
          (shape.streaming
            ? ", and a streamed miss stores it only once the stream has finished. A half-delivered stream is not an answer, and storing one replays a truncated answer with its failure filed off for as long as the entry lives."
            : "."),
      ],
      codeLines(
        `export function withCache${layerParams(shape)}(`,
        `  options: ${optionsType} = {},`,
        `): ${layerType(shape)} {`,
        `  const store = options.store ?? memoryStore${shape.streaming ? "<Answer, Part>" : "<Answer>"}();`,
        "  const namespace = options.namespace ?? \"\";",
        "  const requestKey = options.keyOf ?? cacheKey;",
        "  const cacheable = options.cacheable ?? repeatable;",
        BLANK,
        "  // The namespace goes on here rather than inside `cacheKey`, so a caller's own `keyOf`",
        "  // cannot drop it.",
        "  const keyOf = (request: AnyRequest): string =>",
        "    `${namespace}/${requestKey(request)}`;",
        BLANK,
        "  return {",
        '    name: "cache",',
        BLANK,
        "    wrapGenerate: async (request: AnyRequest, next): Promise<Answer> => {",
        "      if (!cacheable(request)) return next(request);",
        BLANK,
        "      const key = keyOf(request);",
        "      const found = await store.get(key);",
        BLANK,
        ...(shape.streaming
          ? [
              '      if (found !== undefined && found.kind === "answer") return found.answer;',
            ]
          : ["      if (found !== undefined) return found.answer;"]),
        BLANK,
        "      const answer = await next(request);",
        ...(shape.streaming
          ? ['      await store.set(key, { kind: "answer", answer });']
          : ["      await store.set(key, { answer });"]),
        BLANK,
        "      return answer;",
        "    },",
        ...(shape.streaming
          ? [
              BLANK,
              "    wrapStream: (request: AnyRequest, next): AsyncIterable<Part> =>",
              "      (async function* through(): AsyncIterable<Part> {",
              "        if (!cacheable(request)) {",
              "          yield* next(request);",
              BLANK,
              "          return;",
              "        }",
              BLANK,
              "        const key = keyOf(request);",
              "        const found = await store.get(key);",
              BLANK,
              '        if (found !== undefined && found.kind === "parts") {',
              "          yield* found.parts;",
              BLANK,
              "          return;",
              "        }",
              BLANK,
              "        const parts: Part[] = [];",
              BLANK,
              "        for await (const part of next(request)) {",
              "          parts.push(part);",
              "          yield part;",
              "        }",
              BLANK,
              "        // After the loop, so a stream that failed half-way is not stored as though it were a",
              "        // whole answer — which would then be replayed, without its failure, forever.",
              '        await store.set(key, { kind: "parts", parts });',
              "      })(),",
            ]
          : []),
        "  };",
        "}",
      ),
    ),
    documented(
      [
        "Everything about a request that decides its answer.",
        "Built by removing the one field that decides nothing rather than by listing the fields that do. The two failure modes are not equal: a listed set that falls behind a new request field serves a stale answer for a request that asked for something else, where this one's worst case is a miss when two callers spell the same request with their fields in a different order.",
        "The signal is what comes out, because it says nothing about the answer and does not serialise to anything useful.",
      ],
      dedent`
        function cacheKey(request: AnyRequest): string {
          const fields: Record<string, unknown> = { ...request };
          delete fields.signal;

          return JSON.stringify(fields);
        }
      `,
    ),
    documented(
      [
        "Whether asking again would get the same answer. See `cacheable` above for why this is so narrow.",
      ],
      dedent`
        function repeatable(request: AnyRequest): boolean {
          return request.temperature === 0;
        }
      `,
    ),
  );
}

function fallbackLayer(shape: Shape): string {
  return sections(
    documented(
      [
        "A second model, for when the first one cannot answer.",
        "The layer that only exists at this seam. A provider outage is not something the code calling the model can route around — it does not know there is another one — and a layer holding the substitute is the one place the choice is invisible from both sides.",
        "`shouldSwitch` decides what is worth a second attempt. The default declines only for a failure that says it is not retryable, which is the field the chat-model port's error carries and the adapter is the only thing in a position to set: a rejected request will be rejected by the next provider too, and sending it twice turns one bad request into two. A failure with no opinion is tried again, because an unknown error from one provider is exactly the case a different one may survive.",
        shape.streaming
          ? "For a stream the rule is stricter, and it has to be: once a part has been handed over there is no switching. The caller has rendered half an answer, and the second model would begin a different one — so a stream that failed after its first part fails, and only one that failed before it is taken over."
          : "",
      ],
      dedent`
        export interface FallbackOptions {
          readonly shouldSwitch?: (failure: unknown) => boolean;
        }
      `,
    ),
    documented(
      [
        "The layer that holds the substitute.",
        "One extra attempt and not a loop. Retrying the same model is a different pattern with different questions — how long to wait, how many times — and stacking `retry` under this one gives both, in the order the list says.",
      ],
      codeLines(
        `export function withFallback${layerParams(shape)}(`,
        `  other: ${modelType(shape)},`,
        "  options: FallbackOptions = {},",
        `): ${layerType(shape)} {`,
        "  const shouldSwitch = options.shouldSwitch ?? worthAnotherModel;",
        BLANK,
        "  return {",
        '    name: "fallback",',
        BLANK,
        "    wrapGenerate: async (request: AnyRequest, next): Promise<Answer> => {",
        "      try {",
        "        // Awaited inside the `try` rather than returned from it. Returning the promise would",
        "        // hand the rejection to the caller with nothing here to catch it.",
        "        return await next(request);",
        "      } catch (failure) {",
        "        if (!shouldSwitch(failure)) throw failure;",
        BLANK,
        "        return other.generate(request);",
        "      }",
        "    },",
        ...(shape.streaming
          ? [
              BLANK,
              "    wrapStream: (request: AnyRequest, next): AsyncIterable<Part> =>",
              "      (async function* through(): AsyncIterable<Part> {",
              "        let delivered = false;",
              BLANK,
              "        try {",
              "          for await (const part of next(request)) {",
              "            delivered = true;",
              "            yield part;",
              "          }",
              BLANK,
              "          return;",
              "        } catch (failure) {",
              "          if (delivered || !shouldSwitch(failure)) throw failure;",
              "        }",
              BLANK,
              "        // Outside the `catch`, so a failure from the second model is the second model's and",
              "        // not something this layer could be caught trying to handle again.",
              "        yield* other.stream(request);",
              "      })(),",
            ]
          : []),
        "  };",
        "}",
      ),
    ),
    documented(
      [
        "Whether a failure is one a different provider might not have.",
        "Reads a `retryable` field if the error carries one, which the chat-model port's error does. Anything else is worth trying elsewhere.",
      ],
      dedent`
        function worthAnotherModel(failure: unknown): boolean {
          return !(
            typeof failure === "object" &&
            failure !== null &&
            "retryable" in failure &&
            failure.retryable === false
          );
        }
      `,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The example.
// ---------------------------------------------------------------------------------------------------

function example(context: RenderContext, shape: Shape): string {
  const spec = siblingSpecifier(context.conventions, STEM);

  return sections(
    doc(
      "A model with four layers around it, and what each one changes.",
      "The order of the list is the point of the example. `withDefaults` is above `withCache` so that the temperature it fills in is part of what the cache keys on — the other way round, the cache would be keying on a request with no temperature, decide it was not repeatable, and store nothing at all while looking like it worked.",
    ),
    importsFrom(context.conventions, spec, {
      values: [
        "withDefaults",
        "withTelemetry",
        "wrapModel",
        ...(shape.caching ? ["withCache"] : []),
        ...(shape.fallback ? ["withFallback"] : []),
      ],
      types: [
        "AnyRequest",
        "CallReport",
        "Message",
        "MinimalAnswer",
        ...(shape.streaming ? ["MinimalPart"] : []),
        shape.streaming ? "StreamingModel" : "Model",
        "Usage",
      ],
    }),
    documented(
      [
        "What this example's model answers with.",
        "Smaller than a provider's response and that is the demonstration: the layers never name this type, so they neither require it nor reduce it.",
      ],
      codeLines(
        "interface Answer extends MinimalAnswer {",
        "  readonly text: string;",
        "  readonly from: string;",
        "}",
        ...(shape.streaming
          ? [
              BLANK,
              "interface Part extends MinimalPart {",
              "  readonly text?: string;",
              "}",
            ]
          : []),
      ),
    ),
    documented(
      ["What this example's model claims every call cost."],
      "const USAGE: Usage = { inputTokens: 120, outputTokens: 30 };",
    ),
    documented(
      [
        "A stand-in for a provider: it counts what it was asked and can be told to fail.",
        "In real code this is the chat-model port's adapter, and nothing below changes.",
      ],
      codeLines(
        "function provider(",
        "  name: string,",
        "  options: { readonly failing?: boolean } = {},",
        `): { readonly model: ${shape.streaming ? "StreamingModel<Answer, Part>" : "Model<Answer>"}; readonly calls: readonly AnyRequest[] } {`,
        "  const calls: AnyRequest[] = [];",
        BLANK,
        "  return {",
        "    calls,",
        "    model: {",
        "      modelId: name,",
        BLANK,
        "      generate: (request: AnyRequest): Promise<Answer> => {",
        "        calls.push(request);",
        BLANK,
        "        return options.failing === true",
        "          ? Promise.reject(new Error(`${name} is unreachable`))",
        "          : Promise.resolve({ text: `answered at ${String(request.temperature)}`, from: name, usage: USAGE });",
        "      },",
        ...(shape.streaming
          ? [
              BLANK,
              "      stream: (request: AnyRequest): AsyncIterable<Part> =>",
              "        (async function* run(): AsyncIterable<Part> {",
              "          calls.push(request);",
              BLANK,
              "          if (options.failing === true) throw new Error(`${name} is unreachable`);",
              BLANK,
              '          yield { type: "text-delta", text: "ans" };',
              '          yield { type: "text-delta", text: "wered" };',
              '          yield { type: "finish", usage: USAGE };',
              "        })(),",
            ]
          : []),
        "    },",
        "  };",
        "}",
      ),
    ),
    documented(
      ["Where the reports go. A real one goes to whatever collects metrics."],
      codeLines(
        "function line(call: CallReport): void {",
        "  report(",
        ...(shape.streaming
          ? [
              "    `${call.kind} ${call.outcome} in ${String(call.milliseconds)}ms, ` +",
            ]
          : ["    `${call.outcome} in ${String(call.milliseconds)}ms, ` +"]),
        "      `${String(call.usage?.inputTokens)} in / ${String(call.usage?.outputTokens)} out`,",
        "  );",
        "}",
      ),
    ),
    documented(
      [
        "The chain, and what each call through it does.",
        ...(shape.caching
          ? [
              "The second of the two identical calls is answered without the model being asked, which is why its reported duration is a fraction of the first's.",
            ]
          : []),
        ...(shape.fallback
          ? [
              "The last call goes to a model that cannot answer, and comes back from the one behind it.",
            ]
          : []),
      ],
      codeLines(
        "export async function main(): Promise<void> {",
        '  const primary = provider("primary");',
        ...(shape.fallback ? ['  const spare = provider("spare");'] : []),
        BLANK,
        "  const model = wrapModel(primary.model, [",
        "    withTelemetry({ report: line }),",
        "    withDefaults({ temperature: 0, maxOutputTokens: 512 }),",
        ...(shape.caching ? ["    withCache(),"] : []),
        ...(shape.fallback ? ["    withFallback(spare.model),"] : []),
        "  ]);",
        BLANK,
        '  const first = await model.generate({ messages: [asked("how long is a piece of string?")] });',
        '  const second = await model.generate({ messages: [asked("how long is a piece of string?")] });',
        BLANK,
        "  report(`first: ${first.text} (${first.from})`);",
        "  report(`second: ${second.text} (${second.from})`);",
        ...(shape.caching
          ? [
              "  report(`the model was asked ${String(primary.calls.length)} time(s) for two calls`);",
            ]
          : []),
        ...(shape.streaming
          ? [
              BLANK,
              '  let streamed = "";',
              BLANK,
              '  for await (const part of model.stream({ messages: [asked("and again, slowly")] })) {',
              '    streamed += part.text ?? "";',
              "  }",
              BLANK,
              "  report(`streamed: ${streamed}`);",
            ]
          : []),
        ...(shape.fallback
          ? [
              BLANK,
              '  const broken = provider("broken", { failing: true });',
              "  const withSpare = wrapModel(broken.model, [",
              "    withTelemetry({ report: line }),",
              ...(shape.fallback ? ["    withFallback(spare.model),"] : []),
              "  ]);",
              BLANK,
              '  const answered = await withSpare.generate({ messages: [asked("anyone there?")] });',
              BLANK,
              "  report(`after a failure: ${answered.from}`);",
            ]
          : []),
        "}",
      ),
    ),
    documented(
      [
        "One user turn, since every call below needs one and none of them is about its contents.",
      ],
      dedent`
        function asked(text: string): Message {
          return { role: "user", content: [{ type: "text", text }] };
        }
      `,
    ),
    documented(
      ["Stands in for whatever this application logs with."],
      dedent`
        function report(message: string): void {
          console.log(message);
        }
      `,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The type-level suite.
// ---------------------------------------------------------------------------------------------------

function typeTests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const model = shape.streaming
    ? "StreamingModel<Answer, Part>"
    : "Model<Answer>";
  const layer = shape.streaming
    ? "Middleware<Answer, Part>"
    : "Middleware<Answer>";

  return sections(
    doc(
      "The four claims about wrapping that no suite which runs could check.",
      "Each of them is about a type, and by the time anything executes they have all been settled: a wrapped model that has lost the caller's answer type behaves identically at run time to one that kept it, and a `toolChoice` that stopped being checked produces a request the provider rejects rather than a test that fails.",
    ),
    importsFrom(conventions, siblingSpecifier(conventions, STEM), {
      values: ["withDefaults", "wrapModel"],
      types: [
        "MinimalAnswer",
        ...(shape.streaming ? ["MinimalPart"] : []),
        "Middleware",
        shape.streaming ? "StreamingModel" : "Model",
      ],
    }),
    typeAssertKit(["Equal", "Extends", "NotAssignable"]),
    documented(
      [
        "An answer with a field of its own, which is what the claims below are about keeping.",
      ],
      codeLines(
        "interface Answer extends MinimalAnswer {",
        "  readonly text: string;",
        "}",
        ...(shape.streaming
          ? [
              BLANK,
              "interface Part extends MinimalPart {",
              "  readonly text?: string;",
              "}",
            ]
          : []),
        BLANK,
        `declare const model: ${model};`,
        BLANK,
        "const layered = wrapModel(model, [withDefaults({ temperature: 0 })]);",
      ),
    ),
    documented(
      [
        "Wrapping returns the answer the model returns, not the little a layer reads of it.",
        "This is the claim that the layers being generic in the answer exists to keep. A layer declared over `MinimalAnswer` instead makes this `MinimalAnswer` — with no error anywhere near the layer, and none here either until somebody reads a field.",
      ],
      "export type TheAnswerSurvives = Expect<\n  Equal<Awaited<ReturnType<typeof layered.generate>>, Answer>\n>;",
    ),
    documented(
      [
        "A wrapped model is usable everywhere the model was, which is what makes a layer invisible.",
      ],
      `export type StillTheSameModel = Expect<Extends<typeof layered, ${model}>>;`,
    ),
    documented(
      [
        "And a layer written over the bound is refused rather than accepted.",
        "The relationship `NoInfer` on `wrapModel` turns into an error at the call site. Stated here as well, because the directive form would be satisfied by any error on that line.",
      ],
      `export type ALayerOverTheBoundIsRefused = Expect<NotAssignable<Middleware, ${layer}>>;`,
    ),
    documented(
      [
        "The port's tool-name checking survives the wrapper.",
        "The wrapper's `generate` keeps the narrow signature and runs a widened request underneath it, so a name no tool declared is still refused. Written as a call a caller would plausibly make: if the guarantee lapses, the directive becomes unused and this file stops compiling on that.",
      ],
      codeLines(
        "export async function toolNamesAreStillChecked(): Promise<void> {",
        "  await layered.generate({",
        "    messages: [],",
        '    tools: [{ name: "lookup", inputSchema: { type: "object" } }],',
        '    toolChoice: { mode: "tool", toolName: "lookup" },',
        "  });",
        BLANK,
        "  await layered.generate({",
        "    messages: [],",
        '    tools: [{ name: "lookup", inputSchema: { type: "object" } }],',
        "    toolChoice: {",
        '      mode: "tool",',
        "      // @ts-expect-error no tool of that name was declared",
        '      toolName: "lookyp",',
        "    },",
        "  });",
        "}",
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------------------------------

function tests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;

  return sections(
    doc(
      "The layers, against a model that answers from a script.",
      "Nothing here goes near a network, and nothing here reads a clock: the model is a function that records what it was asked and the telemetry layer's clock is passed in, so a duration is an assertable number rather than a range.",
      "What is being pinned is mostly order and mostly invisible. A chain that composes inwards instead of outwards behaves identically with one layer in it; a cache that stores a half-finished stream replays a truncated answer and never errs; a fallback that takes over a stream mid-flight produces two answers spliced together. None of those announce themselves.",
    ),
    frameworkImports(conventions),
    importsFrom(conventions, siblingSpecifier(conventions, STEM), {
      values: [
        "withDefaults",
        "withTelemetry",
        "wrapModel",
        ...(shape.caching ? ["memoryStore", "withCache"] : []),
        ...(shape.fallback ? ["withFallback"] : []),
      ],
      types: [
        "AnyRequest",
        "CallReport",
        "Message",
        "Middleware",
        "MinimalAnswer",
        ...(shape.streaming ? ["MinimalPart"] : []),
        shape.streaming ? "StreamingModel" : "Model",
        "Usage",
      ],
    }),
    testFixtures(shape),
    wrappingCases(shape),
    defaultsCases(),
    telemetryCases(shape),
    when(shape.streaming, lazinessCases()),
    when(shape.caching, cacheCases(shape)),
    when(shape.fallback, fallbackCases(shape)),
  );
}

function testFixtures(shape: Shape): string {
  return sections(
    doc(
      "A model that answers from a script, a clock, and a layer that only records that it ran.",
      "`tap` is generic in the answer for the reason every layer here is, and it is the shortest illustration of what a caller's own layer has to look like.",
    ),
    codeLines(
      "const USAGE: Usage = { inputTokens: 12, outputTokens: 4 };",
      BLANK,
      "/** Thrown by a scripted model, and compared by identity so a test cannot pass on a different failure. */",
      'const OUTAGE = new Error("the provider is unreachable");',
      BLANK,
      "interface Answer extends MinimalAnswer {",
      "  readonly text: string;",
      "  readonly from: string;",
      "}",
      ...(shape.streaming
        ? [
            BLANK,
            "interface Part extends MinimalPart {",
            "  readonly text?: string;",
            "}",
          ]
        : []),
      BLANK,
      "interface Script {",
      "  /** What this model throws instead of answering. */",
      "  readonly failure?: unknown;",
      ...(shape.streaming
        ? [
            "  /** The parts it streams, when it streams. */",
            "  readonly parts?: readonly Part[];",
            "  /** How many parts go out before the failure. Zero means it fails before the first one. */",
            "  readonly failsAfter?: number;",
          ]
        : []),
      "}",
      BLANK,
      "interface Scripted {",
      `  readonly model: ${modelType(shape)};`,
      "  /** Every request that reached the model, in order. */",
      "  readonly seen: readonly AnyRequest[];",
      "}",
    ),
    documented(
      [
        "A model that records what it was asked.",
        "The answer names the model and the temperature it was called at, so a test can tell which model answered and whether a default reached it without inspecting anything else.",
      ],
      codeLines(
        "function scripted(name: string, script: Script = {}): Scripted {",
        "  const seen: AnyRequest[] = [];",
        ...(shape.streaming
          ? [
              "  const parts: readonly Part[] = script.parts ?? [",
              '    { type: "text-delta", text: "ans" },',
              '    { type: "text-delta", text: "wered" },',
              '    { type: "finish", usage: USAGE },',
              "  ];",
            ]
          : []),
        BLANK,
        "  return {",
        "    seen,",
        "    model: {",
        "      modelId: name,",
        BLANK,
        "      generate: (request: AnyRequest): Promise<Answer> => {",
        "        seen.push(request);",
        BLANK,
        "        return script.failure === undefined",
        "          ? Promise.resolve({ text: `at ${String(request.temperature)}`, from: name, usage: USAGE })",
        "          : Promise.reject(script.failure);",
        "      },",
        ...(shape.streaming
          ? [
              BLANK,
              "      stream: (request: AnyRequest): AsyncIterable<Part> =>",
              "        (async function* run(): AsyncIterable<Part> {",
              "          seen.push(request);",
              BLANK,
              "          const failsAfter = script.failsAfter ?? 0;",
              "          let sent = 0;",
              BLANK,
              "          for (const part of parts) {",
              "            if (script.failure !== undefined && sent === failsAfter) throw script.failure;",
              BLANK,
              "            sent += 1;",
              "            yield part;",
              "          }",
              BLANK,
              "          if (script.failure !== undefined && sent === failsAfter) throw script.failure;",
              "        })(),",
            ]
          : []),
        "    },",
        "  };",
        "}",
      ),
    ),
    documented(
      [
        "A clock that reads the given numbers in order and then repeats its last.",
        "Injected rather than mocked, so a reported duration is a fixed number. Reading the real clock twice would leave a suite asserting only that a duration is a number, which is also true of a negative one.",
      ],
      dedent`
        function clock(ticks: readonly number[]): () => number {
          let index = 0;

          return (): number => {
            const tick = ticks[index] ?? ticks[ticks.length - 1] ?? 0;
            index += 1;

            return tick;
          };
        }
      `,
    ),
    documented(
      [
        "A layer that changes nothing and records that it ran.",
        "Generic in the answer" +
          (shape.streaming ? " and the part" : "") +
          ", which is not a stylistic choice: a layer declared over the bound would make this file's wrapped models answer with `MinimalAnswer` and every assertion below about `text` would stop compiling.",
      ],
      codeLines(
        `function tap${layerParams(shape)}(`,
        "  name: string,",
        "  log: string[],",
        `): ${layerType(shape)} {`,
        "  return {",
        "    name,",
        BLANK,
        "    transformRequest: (request: AnyRequest): AnyRequest => {",
        "      log.push(`${name}:request`);",
        BLANK,
        "      return request;",
        "    },",
        BLANK,
        "    wrapGenerate: async (request: AnyRequest, next): Promise<Answer> => {",
        "      log.push(`${name}:before`);",
        BLANK,
        "      const answer = await next(request);",
        BLANK,
        "      log.push(`${name}:after`);",
        BLANK,
        "      return answer;",
        "    },",
        "  };",
        "}",
      ),
    ),
    documented(
      ["The last request a model received, or a failure if it received none."],
      dedent`
        function lastOf(requests: readonly AnyRequest[]): AnyRequest {
          const request = requests[requests.length - 1];

          if (request === undefined) throw new Error("the model was never asked");

          return request;
        }
      `,
    ),
    documented(
      [
        "The one report a call should have produced.",
        "Fails on none and on two, because a layer that reports a call twice is as wrong as one that does not report it and neither shows up in an assertion about the first entry.",
      ],
      dedent`
        function only(reports: readonly CallReport[]): CallReport {
          const report = reports[0];

          if (report === undefined) throw new Error("nothing was reported");
          if (reports.length > 1) throw new Error(\`\${String(reports.length)} calls were reported\`);

          return report;
        }
      `,
    ),
    documented(
      ["One user turn. No test here is about its contents."],
      dedent`
        function asked(text: string): Message {
          return { role: "user", content: [{ type: "text", text }] };
        }
      `,
    ),
    when(
      shape.streaming,
      documented(
        ["A whole stream, and the text in it."],
        dedent`
          async function collect(stream: AsyncIterable<Part>): Promise<readonly Part[]> {
            const parts: Part[] = [];

            for await (const part of stream) parts.push(part);

            return parts;
          }

          function textOf(parts: readonly Part[]): string {
            return parts.map((part) => part.text ?? "").join("");
          }
        `,
      ),
    ),
  );
}

function wrappingCases(shape: Shape): string {
  return codeLines(
    'describe("wrapping a model", () => {',
    '  it("keeps the model\'s id, so a layer is not a different model", () => {',
    '    const primary = scripted("primary");',
    BLANK,
    '    expect(wrapModel(primary.model, []).modelId).toBe("primary");',
    "  });",
    BLANK,
    '  it("with no layers, answers exactly as the model does", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, []);",
    BLANK,
    '    const answer = await model.generate({ messages: [asked("hello")], temperature: 0.5 });',
    BLANK,
    '    expect(answer.from).toBe("primary");',
    '    expect(answer.text).toBe("at 0.5");',
    "  });",
    BLANK,
    '  it("runs the first layer outermost and the last innermost", async () => {',
    '    const primary = scripted("primary");',
    "    const log: string[] = [];",
    '    const model = wrapModel(primary.model, [tap("outer", log), tap("inner", log)]);',
    BLANK,
    '    await model.generate({ messages: [asked("hello")] });',
    BLANK,
    "    expect(log).toEqual([",
    '      "outer:request",',
    '      "outer:before",',
    '      "inner:request",',
    '      "inner:before",',
    '      "inner:after",',
    '      "outer:after",',
    "    ]);",
    "  });",
    BLANK,
    '  it("shows a layer its own transformed request", async () => {',
    '    const primary = scripted("primary");',
    "    const wrapped: (number | undefined)[] = [];",
    `    const layer: ${layerType(shape)} = {`,
    '      name: "warm",',
    "      transformRequest: (request: AnyRequest): AnyRequest => ({ ...request, temperature: 0.25 }),",
    "      wrapGenerate: (request: AnyRequest, next): Promise<Answer> => {",
    "        wrapped.push(request.temperature);",
    BLANK,
    "        return next(request);",
    "      },",
    "    };",
    BLANK,
    "    await wrapModel(primary.model, [layer]).generate({",
    '      messages: [asked("hello")],',
    "    });",
    BLANK,
    "    expect(wrapped).toEqual([0.25]);",
    "    expect(lastOf(primary.seen).temperature).toBe(0.25);",
    "  });",
    BLANK,
    '  it("does not leave one wrapper\'s layers on another", async () => {',
    '    const primary = scripted("primary");',
    "    const first: string[] = [];",
    "    const second: string[] = [];",
    BLANK,
    '    await wrapModel(primary.model, [tap("first", first)]).generate({ messages: [] });',
    '    await wrapModel(primary.model, [tap("second", second)]).generate({ messages: [] });',
    BLANK,
    "    expect(first).toHaveLength(3);",
    "    expect(second).toHaveLength(3);",
    "  });",
    ...(shape.streaming
      ? [
          BLANK,
          '  it("leaves a layer that wraps neither kind of call out of the way of both", async () => {',
          '    const primary = scripted("primary");',
          `    const counting: ${layerType(shape)} = {`,
          '      name: "counting",',
          "      transformRequest: (request: AnyRequest): AnyRequest => ({ ...request, temperature: 0 }),",
          "    };",
          "    const model = wrapModel(primary.model, [counting]);",
          BLANK,
          '    await model.generate({ messages: [asked("hello")] });',
          '    await collect(model.stream({ messages: [asked("hello")] }));',
          BLANK,
          "    expect(primary.seen).toHaveLength(2);",
          "    expect(primary.seen.every((request) => request.temperature === 0)).toBe(true);",
          "  });",
        ]
      : []),
    "});",
  );
}

function defaultsCases(): string {
  return codeLines(
    'describe("request defaults", () => {',
    '  it("fills in what the request did not bring", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [",
    '      withDefaults({ system: "be brief", temperature: 0.7, maxOutputTokens: 256 }),',
    "    ]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")] });',
    BLANK,
    "    const request = lastOf(primary.seen);",
    BLANK,
    '    expect(request.system).toBe("be brief");',
    "    expect(request.temperature).toBe(0.7);",
    "    expect(request.maxOutputTokens).toBe(256);",
    "  });",
    BLANK,
    '  it("leaves what the request did bring", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withDefaults({ temperature: 0.7 })]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")], temperature: 0.1 });',
    BLANK,
    "    expect(lastOf(primary.seen).temperature).toBe(0.1);",
    "  });",
    BLANK,
    '  it("keeps a temperature of zero, which is the value a caller most means", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withDefaults({ temperature: 0.7 })]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")], temperature: 0 });',
    BLANK,
    "    expect(lastOf(primary.seen).temperature).toBe(0);",
    "  });",
    BLANK,
    '  it("writes nothing for a field neither side has an opinion about", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withDefaults({ temperature: 0 })]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")] });',
    BLANK,
    "    const request = lastOf(primary.seen);",
    BLANK,
    "    // Absent rather than present and `undefined`: a provider treats the two differently.",
    '    expect("system" in request).toBe(false);',
    '    expect("maxOutputTokens" in request).toBe(false);',
    "  });",
    BLANK,
    '  it("leaves the rest of the request alone", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withDefaults({ temperature: 0 })]);",
    BLANK,
    "    await model.generate({",
    '      messages: [asked("hello")],',
    '      stopSequences: ["\\n\\n"],',
    "    });",
    BLANK,
    '    expect(lastOf(primary.seen).stopSequences).toEqual(["\\n\\n"]);',
    "    expect(lastOf(primary.seen).messages).toHaveLength(1);",
    "  });",
    "});",
  );
}

function telemetryCases(shape: Shape): string {
  return codeLines(
    'describe("telemetry", () => {',
    '  it("reports the duration, the outcome, and what the call cost", async () => {',
    '    const primary = scripted("primary");',
    "    const reports: CallReport[] = [];",
    "    const model = wrapModel(primary.model, [",
    "      withTelemetry({",
    "        report: (call: CallReport): void => {",
    "          reports.push(call);",
    "        },",
    "        now: clock([1000, 1120]),",
    "      }),",
    "    ]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")] });',
    BLANK,
    "    const report = only(reports);",
    BLANK,
    ...(shape.streaming ? ['    expect(report.kind).toBe("generate");'] : []),
    '    expect(report.outcome).toBe("answered");',
    "    expect(report.milliseconds).toBe(120);",
    "    expect(report.usage).toEqual(USAGE);",
    "    expect(report.failure).toBeUndefined();",
    "    expect(report.request.messages).toHaveLength(1);",
    "  });",
    BLANK,
    '  it("reports a failure and lets it through", async () => {',
    '    const primary = scripted("primary", { failure: OUTAGE });',
    "    const reports: CallReport[] = [];",
    "    const model = wrapModel(primary.model, [",
    "      withTelemetry({",
    "        report: (call: CallReport): void => {",
    "          reports.push(call);",
    "        },",
    "        now: clock([500, 530]),",
    "      }),",
    "    ]);",
    BLANK,
    '    await expect(model.generate({ messages: [asked("hello")] })).rejects.toBe(OUTAGE);',
    BLANK,
    "    const report = only(reports);",
    BLANK,
    '    expect(report.outcome).toBe("failed");',
    "    expect(report.milliseconds).toBe(30);",
    "    expect(report.usage).toBeUndefined();",
    "    expect(report.failure).toBe(OUTAGE);",
    "  });",
    BLANK,
    '  it("reads the clock rather than requiring one", async () => {',
    '    const primary = scripted("primary");',
    "    const reports: CallReport[] = [];",
    "    const model = wrapModel(primary.model, [",
    "      withTelemetry({",
    "        report: (call: CallReport): void => {",
    "          reports.push(call);",
    "        },",
    "      }),",
    "    ]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")] });',
    BLANK,
    '    expect(typeof only(reports).milliseconds).toBe("number");',
    "  });",
    ...(shape.streaming
      ? [
          BLANK,
          '  it("reports a stream once it has finished, with the usage its last part carried", async () => {',
          '    const primary = scripted("primary");',
          "    const reports: CallReport[] = [];",
          "    const model = wrapModel(primary.model, [",
          "      withTelemetry({",
          "        report: (call: CallReport): void => {",
          "          reports.push(call);",
          "        },",
          "        now: clock([0, 45]),",
          "      }),",
          "    ]);",
          BLANK,
          '    const parts = await collect(model.stream({ messages: [asked("hello")] }));',
          BLANK,
          '    expect(textOf(parts)).toBe("answered");',
          BLANK,
          "    const report = only(reports);",
          BLANK,
          '    expect(report.kind).toBe("stream");',
          '    expect(report.outcome).toBe("answered");',
          "    expect(report.milliseconds).toBe(45);",
          "    expect(report.usage).toEqual(USAGE);",
          "  });",
          BLANK,
          '  it("keeps a usage that arrived before the last part", async () => {',
          '    const primary = scripted("primary", {',
          "      parts: [",
          '        { type: "text-delta", text: "a" },',
          '        { type: "usage", usage: USAGE },',
          '        { type: "text-delta", text: "b" },',
          "      ],",
          "    });",
          "    const reports: CallReport[] = [];",
          "    const model = wrapModel(primary.model, [",
          "      withTelemetry({",
          "        report: (call: CallReport): void => {",
          "          reports.push(call);",
          "        },",
          "      }),",
          "    ]);",
          BLANK,
          '    await collect(model.stream({ messages: [asked("hello")] }));',
          BLANK,
          "    // The last part carries none, and the reported usage is still the one that went past.",
          "    expect(only(reports).usage).toEqual(USAGE);",
          "  });",
          BLANK,
          '  it("does not report a stream the caller walked away from", async () => {',
          '    const primary = scripted("primary");',
          "    const reports: CallReport[] = [];",
          "    const model = wrapModel(primary.model, [",
          "      withTelemetry({",
          "        report: (call: CallReport): void => {",
          "          reports.push(call);",
          "        },",
          "      }),",
          "    ]);",
          BLANK,
          '    for await (const part of model.stream({ messages: [asked("hello")] })) {',
          '      expect(part.text).toBe("ans");',
          "      break;",
          "    }",
          BLANK,
          "    // An abandoned stream is neither answered nor failed, and reporting it as either is a lie",
          "    // that shows up as a latency figure nobody can account for.",
          "    expect(reports).toHaveLength(0);",
          "  });",
          BLANK,
          '  it("reports a stream that failed after it had begun", async () => {',
          '    const primary = scripted("primary", { failure: OUTAGE, failsAfter: 1 });',
          "    const reports: CallReport[] = [];",
          "    const model = wrapModel(primary.model, [",
          "      withTelemetry({",
          "        report: (call: CallReport): void => {",
          "          reports.push(call);",
          "        },",
          "      }),",
          "    ]);",
          BLANK,
          '    await expect(collect(model.stream({ messages: [asked("hello")] }))).rejects.toBe(OUTAGE);',
          BLANK,
          '    expect(only(reports).outcome).toBe("failed");',
          "    expect(only(reports).failure).toBe(OUTAGE);",
          "  });",
        ]
      : []),
    "});",
  );
}

function lazinessCases(): string {
  return codeLines(
    'describe("streams are not started early", () => {',
    '  it("does not run a layer until the first part is asked for", async () => {',
    '    const primary = scripted("primary");',
    "    const log: string[] = [];",
    '    const model = wrapModel(primary.model, [tap("outer", log)]);',
    BLANK,
    '    const stream = model.stream({ messages: [asked("hello")] });',
    BLANK,
    "    // Returning an `AsyncIterable` rather than a promise of one is only honest if nothing has",
    "    // happened yet. A caller that builds a stream and abandons it has run no layer and sent no",
    "    // request.",
    "    expect(log).toEqual([]);",
    "    expect(primary.seen).toHaveLength(0);",
    BLANK,
    '    expect(textOf(await collect(stream))).toBe("answered");',
    BLANK,
    "    // `tap` wraps `generate` and not `stream`, so its request transform ran and its wrapper did",
    "    // not — which is the hook split doing what it says.",
    '    expect(log).toEqual(["outer:request"]);',
    "    expect(primary.seen).toHaveLength(1);",
    "  });",
    BLANK,
    '  it("waits for an asynchronous transform before the model sees the request", async () => {',
    '    const primary = scripted("primary");',
    "    const later: Middleware<Answer, Part> = {",
    '      name: "later",',
    "      transformRequest: (request: AnyRequest): Promise<AnyRequest> =>",
    "        Promise.resolve({ ...request, temperature: 0 }),",
    "    };",
    BLANK,
    '    await collect(wrapModel(primary.model, [later]).stream({ messages: [asked("hello")] }));',
    BLANK,
    "    expect(lastOf(primary.seen).temperature).toBe(0);",
    "  });",
    "});",
  );
}

function cacheCases(shape: Shape): string {
  return codeLines(
    'describe("caching", () => {',
    '  it("answers a repeated request without asking the model", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withCache()]);",
    '    const request = { messages: [asked("how long is a piece of string?")], temperature: 0 };',
    BLANK,
    "    const first = await model.generate(request);",
    "    const second = await model.generate(request);",
    BLANK,
    "    expect(primary.seen).toHaveLength(1);",
    "    expect(second).toEqual(first);",
    "  });",
    BLANK,
    '  it("asks again for a request it has not seen", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withCache()]);",
    BLANK,
    '    await model.generate({ messages: [asked("one")], temperature: 0 });',
    '    await model.generate({ messages: [asked("two")], temperature: 0 });',
    BLANK,
    "    expect(primary.seen).toHaveLength(2);",
    "  });",
    BLANK,
    '  it("does not cache a request that asked the model to vary", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withCache()]);",
    '    const request = { messages: [asked("surprise me")], temperature: 0.9 };',
    BLANK,
    "    await model.generate(request);",
    "    await model.generate(request);",
    BLANK,
    "    expect(primary.seen).toHaveLength(2);",
    "  });",
    BLANK,
    '  it("does not cache a request that never named a temperature", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withCache()]);",
    '    const request = { messages: [asked("surprise me")] };',
    BLANK,
    "    await model.generate(request);",
    "    await model.generate(request);",
    BLANK,
    "    // The providers default it to something above zero, so an unset temperature is a sample and",
    "    // not a lookup. Treating it as cacheable would serve one sample forever.",
    "    expect(primary.seen).toHaveLength(2);",
    "  });",
    BLANK,
    '  it("tells apart two requests that differ in one field", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withCache()]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")], temperature: 0 });',
    '    await model.generate({ messages: [asked("hello")], temperature: 0, system: "be brief" });',
    BLANK,
    "    // The same conversation is not the same request. A key built from a chosen few fields serves",
    "    // the first answer for the second question.",
    "    expect(primary.seen).toHaveLength(2);",
    "  });",
    BLANK,
    '  it("keys on everything about a request except the signal", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withCache()]);",
    '    const request = { messages: [asked("hello")], temperature: 0 };',
    BLANK,
    "    await model.generate(request);",
    "    await model.generate({ ...request, signal: new AbortController().signal });",
    "    await model.generate({ ...request, signal: new AbortController().signal });",
    BLANK,
    "    // The same question three times, twice with a way to cancel it. A signal says nothing about",
    "    // the answer, and it is not the same signal twice — so a key that kept it would miss on every",
    "    // request a caller can cancel, which is every request worth caching.",
    "    expect(primary.seen).toHaveLength(1);",
    "  });",
    BLANK,
    '  it("is keyed on the request the layers above it produced", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withDefaults({ temperature: 0 }), withCache()]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")] });',
    '    await model.generate({ messages: [asked("hello")] });',
    BLANK,
    "    expect(primary.seen).toHaveLength(1);",
    "  });",
    BLANK,
    '  it("caches nothing when the defaults are applied below it", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withCache(), withDefaults({ temperature: 0 })]);",
    BLANK,
    '    await model.generate({ messages: [asked("hello")] });',
    '    await model.generate({ messages: [asked("hello")] });',
    BLANK,
    "    // The order in the example is not decoration. From inside the cache the request has no",
    "    // temperature yet, so nothing is cacheable and the layer does nothing at all — quietly.",
    "    expect(primary.seen).toHaveLength(2);",
    "  });",
    BLANK,
    '  it("takes a caller\'s answer about what may be cached", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [withCache({ cacheable: (): boolean => true })]);",
    '    const request = { messages: [asked("surprise me")], temperature: 0.9 };',
    BLANK,
    "    await model.generate(request);",
    "    await model.generate(request);",
    BLANK,
    "    expect(primary.seen).toHaveLength(1);",
    "  });",
    BLANK,
    '  it("takes a caller\'s key, however coarse", async () => {',
    '    const primary = scripted("primary");',
    "    const model = wrapModel(primary.model, [",
    '      withCache({ keyOf: (): string => "everything is the same request" }),',
    "    ]);",
    BLANK,
    '    await model.generate({ messages: [asked("one")], temperature: 0 });',
    '    const second = await model.generate({ messages: [asked("two")], temperature: 0 });',
    BLANK,
    "    expect(primary.seen).toHaveLength(1);",
    '    expect(second.from).toBe("primary");',
    "  });",
    BLANK,
    '  it("shares one model\'s answers across two wrappers", async () => {',
    '    const primary = scripted("primary");',
    ...(shape.streaming
      ? ["    const store = memoryStore<Answer, Part>();"]
      : ["    const store = memoryStore<Answer>();"]),
    '    const request = { messages: [asked("hello")], temperature: 0 };',
    BLANK,
    "    await wrapModel(primary.model, [withCache({ store })]).generate(request);",
    "    const second = await wrapModel(primary.model, [withCache({ store })]).generate(request);",
    BLANK,
    "    expect(primary.seen).toHaveLength(1);",
    '    expect(second.from).toBe("primary");',
    "  });",
    BLANK,
    '  it("keeps two models apart in a store they share", async () => {',
    '    const primary = scripted("primary");',
    '    const other = scripted("other");',
    ...(shape.streaming
      ? ["    const store = memoryStore<Answer, Part>();"]
      : ["    const store = memoryStore<Answer>();"]),
    '    const request = { messages: [asked("hello")], temperature: 0 };',
    BLANK,
    "    // Without the namespaces the second call is served the first model's answer, because a",
    "    // request says nothing about where it was going.",
    "    await wrapModel(primary.model, [",
    '      withCache({ store, namespace: "primary" }),',
    "    ]).generate(request);",
    BLANK,
    "    const second = await wrapModel(other.model, [",
    '      withCache({ store, namespace: "other" }),',
    "    ]).generate(request);",
    BLANK,
    "    expect(other.seen).toHaveLength(1);",
    '    expect(second.from).toBe("other");',
    "  });",
    ...(shape.streaming
      ? [
          BLANK,
          '  it("replays the parts of a stream it has already seen", async () => {',
          '    const primary = scripted("primary");',
          "    const model = wrapModel(primary.model, [withCache()]);",
          '    const request = { messages: [asked("hello")], temperature: 0 };',
          BLANK,
          "    const first = await collect(model.stream(request));",
          "    const second = await collect(model.stream(request));",
          "    const third = await collect(model.stream(request));",
          BLANK,
          "    expect(primary.seen).toHaveLength(1);",
          BLANK,
          "    // Three times, because an `AsyncIterable` handed out twice is empty the second time. What",
          "    // is stored is the parts, and each hit is a fresh iteration over them.",
          '    expect(textOf(first)).toBe("answered");',
          '    expect(textOf(second)).toBe("answered");',
          '    expect(textOf(third)).toBe("answered");',
          "  });",
          BLANK,
          '  it("keeps a stream and an answer apart under the same key", async () => {',
          '    const primary = scripted("primary");',
          "    const model = wrapModel(primary.model, [withCache()]);",
          '    const request = { messages: [asked("hello")], temperature: 0 };',
          BLANK,
          "    await model.generate(request);",
          "    const parts = await collect(model.stream(request));",
          BLANK,
          "    // A stored answer is not a stream, so the streamed call is a miss rather than a hit that",
          "    // yields nothing.",
          '    expect(textOf(parts)).toBe("answered");',
          "  });",
          BLANK,
          '  it("does not answer a waited-for call out of a stored stream", async () => {',
          '    const primary = scripted("primary");',
          "    const model = wrapModel(primary.model, [withCache()]);",
          '    const request = { messages: [asked("hello")], temperature: 0 };',
          BLANK,
          "    await collect(model.stream(request));",
          "    const answer = await model.generate(request);",
          BLANK,
          "    // The other direction, and the worse one: handed over as an answer, a list of parts is an",
          "    // `undefined` that surfaces several frames from here.",
          '    expect(answer.from).toBe("primary");',
          "    expect(primary.seen).toHaveLength(2);",
          "  });",
          BLANK,
          '  it("does not store a stream that failed part-way", async () => {',
          '    const primary = scripted("primary", { failure: OUTAGE, failsAfter: 2 });',
          "    const model = wrapModel(primary.model, [withCache()]);",
          '    const request = { messages: [asked("hello")], temperature: 0 };',
          BLANK,
          "    await expect(collect(model.stream(request))).rejects.toBe(OUTAGE);",
          "    await expect(collect(model.stream(request))).rejects.toBe(OUTAGE);",
          BLANK,
          "    // Storing it would replay a truncated answer with the failure filed off, for as long as",
          "    // the entry lived.",
          "    expect(primary.seen).toHaveLength(2);",
          "  });",
          BLANK,
          '  it("does not store a stream the caller walked away from", async () => {',
          '    const primary = scripted("primary");',
          "    const model = wrapModel(primary.model, [withCache()]);",
          '    const request = { messages: [asked("hello")], temperature: 0 };',
          BLANK,
          "    for await (const part of model.stream(request)) {",
          '      expect(part.text).toBe("ans");',
          "      break;",
          "    }",
          BLANK,
          '    expect(textOf(await collect(model.stream(request)))).toBe("answered");',
          "    expect(primary.seen).toHaveLength(2);",
          "  });",
        ]
      : []),
    "});",
  );
}

function fallbackCases(shape: Shape): string {
  return codeLines(
    'describe("falling back to another model", () => {',
    "  /** A failure that says asking again is pointless, as the chat-model port's error does. */",
    '  const REJECTED = Object.assign(new Error("that request was rejected"), { retryable: false });',
    BLANK,
    '  it("answers from the second model when the first cannot", async () => {',
    '    const broken = scripted("broken", { failure: OUTAGE });',
    '    const spare = scripted("spare");',
    "    const model = wrapModel(broken.model, [withFallback(spare.model)]);",
    BLANK,
    '    const answer = await model.generate({ messages: [asked("hello")] });',
    BLANK,
    '    expect(answer.from).toBe("spare");',
    "    expect(broken.seen).toHaveLength(1);",
    "    expect(spare.seen).toHaveLength(1);",
    BLANK,
    "    // The same request, not a reconstruction of it. The second model is answering the question",
    "    // the first one could not.",
    "    expect(lastOf(spare.seen)).toEqual(lastOf(broken.seen));",
    "  });",
    BLANK,
    '  it("does not ask the second model about a request the first one refused", async () => {',
    '    const broken = scripted("broken", { failure: REJECTED });',
    '    const spare = scripted("spare");',
    "    const model = wrapModel(broken.model, [withFallback(spare.model)]);",
    BLANK,
    '    await expect(model.generate({ messages: [asked("hello")] })).rejects.toBe(REJECTED);',
    BLANK,
    "    // A malformed request is malformed for both providers, and sending it twice turns one bad",
    "    // request into two.",
    "    expect(spare.seen).toHaveLength(0);",
    "  });",
    BLANK,
    '  it("lets the second model\'s own failure through", async () => {',
    '    const second = new Error("the spare is unreachable too");',
    '    const broken = scripted("broken", { failure: OUTAGE });',
    '    const spare = scripted("spare", { failure: second });',
    "    const model = wrapModel(broken.model, [withFallback(spare.model)]);",
    BLANK,
    '    await expect(model.generate({ messages: [asked("hello")] })).rejects.toBe(second);',
    "  });",
    BLANK,
    '  it("takes a caller\'s answer about what is worth another model", async () => {',
    '    const broken = scripted("broken", { failure: REJECTED });',
    '    const spare = scripted("spare");',
    "    const model = wrapModel(broken.model, [",
    "      withFallback(spare.model, { shouldSwitch: (): boolean => true }),",
    "    ]);",
    BLANK,
    '    expect((await model.generate({ messages: [asked("hello")] })).from).toBe("spare");',
    "  });",
    ...(shape.streaming
      ? [
          BLANK,
          '  it("takes over a stream that failed before its first part", async () => {',
          '    const broken = scripted("broken", { failure: OUTAGE });',
          '    const spare = scripted("spare");',
          "    const model = wrapModel(broken.model, [withFallback(spare.model)]);",
          BLANK,
          '    const parts = await collect(model.stream({ messages: [asked("hello")] }));',
          BLANK,
          '    expect(textOf(parts)).toBe("answered");',
          "    expect(spare.seen).toHaveLength(1);",
          "  });",
          BLANK,
          '  it("does not take over a stream that had already begun", async () => {',
          '    const broken = scripted("broken", { failure: OUTAGE, failsAfter: 1 });',
          '    const spare = scripted("spare");',
          "    const model = wrapModel(broken.model, [withFallback(spare.model)]);",
          BLANK,
          '    await expect(collect(model.stream({ messages: [asked("hello")] }))).rejects.toBe(OUTAGE);',
          BLANK,
          "    // The caller has rendered half an answer. A second model would start a different one, and",
          "    // the two spliced together are worse than the failure.",
          "    expect(spare.seen).toHaveLength(0);",
          "  });",
        ]
      : []),
    "});",
  );
}
