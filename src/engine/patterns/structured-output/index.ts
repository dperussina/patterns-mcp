/**
 * The `structured-output` pattern: a schema'd value out of a chat model, with the retry a failed
 * validation earns.
 *
 * Four decisions, each settled with the compiler or against a real schema library before the templates
 * were written.
 *
 * **The schema arrives through Standard Schema v1, declared here rather than imported.** The interface is
 * a `~standard` property carrying a version, a vendor name and a `validate` function, and Zod, Valibot and
 * ArkType all implement it. Declaring it by hand is fifteen lines and buys the whole thing: a caller hands
 * in `z.object({...})` and the inferred output type flows through the generic to the returned value. That
 * was checked against `zod@4.4.3` in this repository — assignability *and* inference, under
 * `exactOptionalPropertyTypes` — because a hand-declared structural copy of someone else's interface is
 * exactly the kind of claim that is either verified or wrong.
 *
 * **The JSON Schema is a second argument, and that is not a wart.** Standard Schema v1 deliberately
 * carries no JSON Schema export, so there is nothing to derive the wire shape from. Converting inside the
 * pattern would mean importing a converter — `z.toJSONSchema` for Zod, a companion package for Valibot —
 * which is the dependency the interface exists to avoid. So the caller passes both, and the emitted docs
 * say plainly that they have to agree.
 *
 * **The correction differs by strategy, and getting it wrong is a provider error rather than a bad
 * answer.** Under `tool-call` the model's failed attempt is an assistant message containing a tool call,
 * and both mainstream wire formats reject a following request in which that call has no matching tool
 * result — so the complaint has to travel *as* the tool result, `failed: true`, carrying the call's id.
 * Under the text strategies there is no call to answer, so the complaint is a user message after an
 * assistant echo. A hand-rolled retry loop that sends a user message in both cases works until the first
 * time it retries a tool call, and then fails with a 400 that says nothing about schemas.
 *
 * **The model seam is narrower than the port and structurally satisfied by it.** `StructuredModel` is one
 * method taking the fields this pattern actually sets; the chat-model port's `ChatModel` is assignable to
 * it, verified in both directions, including the awkward part — the port spells a named tool choice
 * against the literal union of the tool names it was given, and this seam spells it `string`.
 *
 * The `response-format` strategy writes its instruction into `providerOptions` because the port's request
 * has no field for it, and that is the honest shape: JSON mode is not part of the subset every provider
 * agrees on. Anthropic has no equivalent at all, which is the reason `tool-call` is the default here
 * rather than the one everybody reaches for first.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { expectFileEntry, frameworkImports } from "../expect-file.js";
import { dedent, doc, documented, joinLines, sections, when } from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

const STEM = "structured-output";

export const structuredOutputPattern: PatternModule = {
  name: "structured-output",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const strategy =
      options.strategy === "response-format" || options.strategy === "prompt"
        ? options.strategy
        : "tool-call";
    const shape: Shape = {
      strategy,
      tool: strategy === "tool-call",
      jsonMode: strategy === "response-format",
      retry: options.onInvalid !== "refuse",
    };

    const files: RenderedFile[] = [
      { path: `${STEM}.ts`, role: "core", contents: core(shape) },
      { path: `${STEM}-example.ts`, role: "example", contents: example(context, shape) },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({ path: `${STEM}.test.ts`, role: "test", contents: tests(context, shape) });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

interface Shape {
  readonly strategy: "response-format" | "tool-call" | "prompt";
  /** `strategy: "tool-call"` — the value arrives as a tool call's input rather than as text. */
  readonly tool: boolean;
  /** `strategy: "response-format"` — the model was told to answer in JSON by the request. */
  readonly jsonMode: boolean;
  /** `onInvalid: "retry"` — a wrong answer is sent back with its problems named. */
  readonly retry: boolean;
}

// ---------------------------------------------------------------------------------------------------
// The core.
// ---------------------------------------------------------------------------------------------------

function core(shape: Shape): string {
  return sections(
    coreHeader(shape),
    schemaTypes(),
    seamTypes(),
    errorTypes(shape),
    requestType(shape),
    resultType(shape),
    entryPoint(shape),
    requestShaping(shape),
    payloadReading(shape),
    when(shape.retry, correction(shape)),
    issueRendering(),
    when(shape.retry, usageTotals()),
  );
}

function coreHeader(shape: Shape): string {
  return doc(
    "A value out of a chat model, checked against a schema before you see it.",
    "The model is asked for JSON, the answer is located and parsed, and the result is handed to a schema for validation. What comes back is the schema's own output type — not `unknown`, and not a cast.",
    "Nothing here is imported. The schema arrives through the Standard Schema interface declared below, which Zod, Valibot and ArkType all implement, so `z.object({ ... })` fits with no dependency in either direction and so does a fifteen-line object you write yourself.",
    shape.tool
      ? "The model is asked through a tool it must call, which is the only way that works on every provider: tool calling is universal, JSON mode is not. The value is the call's input, so there is no parsing of prose at all in the happy case — the adapter already did it."
      : shape.jsonMode
        ? "The model is asked through the request's response-format field, which is what an OpenAI-compatible endpoint understands. That field is not part of the subset every provider agrees on, so it travels in `providerOptions`; a provider that ignores it answers in prose, and the reader below says so in a warning rather than failing mysteriously."
        : "The model is asked in the prompt, which is the strategy for a model with neither JSON mode nor tools. The answer is expected to be prose-wrapped, so the reader pulls the first JSON value out of it — code fence and all.",
    shape.retry
      ? "An answer that does not validate is sent back with its problems named, bounded by `maxAttempts`. That is worth more than it sounds: most schema failures are a missing field or a number sent as a string, and a model told exactly which path was wrong usually fixes it on the second try."
      : "An answer that does not validate is a refusal, with the issues and the value attached. That is the strict reading, and it is a generation-time choice: `onInvalid: \"retry\"` sends the problems back to the model instead.",
  );
}

function schemaTypes(): string {
  return sections(
    doc(
      "The schema interface, declared rather than imported.",
      "This is Standard Schema v1: a single `~standard` property, which Zod 3.24+, Valibot 1.0+ and ArkType 2.0+ all carry. Declaring it here is what lets this file depend on nothing while still accepting the schema library you already use.",
      "It carries no JSON Schema, on purpose — which is why the request below asks for one separately. Deriving it would mean importing a converter, and that is the dependency this interface exists to avoid.",
    ),
    documented(
      [
        "One thing wrong with the value.",
        "`path` is the route to the offending field, and a segment may be a bare key or an object wrapping one — the specification allows both, so anything reading it has to accept both.",
      ],
      dedent`
        export interface StandardIssue {
          readonly message: string;
          readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
        }
      `,
    ),
    documented(
      [
        "What validation came back with.",
        "`issues` present means failure, and the discriminant is its absence rather than a flag — that is how the libraries spell it, and this file has to accept their spelling.",
        "Absence is a weaker discriminant than a literal, though: it narrows under `strict` and stops narrowing in a project with `strictNullChecks` off, where `issues?: undefined` no longer distinguishes the two arms and reading `value` off the union is an error. So nothing below narrows this by hand; `accepted` does it once, for everyone.",
      ],
      dedent`
        export type StandardResult<Output> =
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: readonly StandardIssue[] };
      `,
    ),
    documented(
      [
        "Whether validation succeeded, as a narrowing the compiler keeps.",
        "A predicate rather than an inline `issues === undefined`, because that comparison narrows only in a project with `strictNullChecks` on and this pattern compiles in projects without it. The predicate states the conclusion, so it holds either way.",
      ],
      dedent`
        function accepted<Output>(
          result: StandardResult<Output>,
        ): result is { readonly value: Output; readonly issues?: undefined } {
          return result.issues === undefined;
        }
      `,
    ),
    documented(
      [
        "A schema, whoever wrote it.",
        "`validate` may be synchronous or not, so it is awaited either way. `types` exists only to carry the input and output types — nothing reads it at run time, and a hand-written schema can leave it out entirely.",
      ],
      dedent`
        export interface StandardSchemaV1<Input = unknown, Output = Input> {
          readonly "~standard": {
            readonly version: 1;
            readonly vendor: string;
            readonly validate: (
              value: unknown,
            ) => StandardResult<Output> | Promise<StandardResult<Output>>;
            readonly types?: { readonly input: Input; readonly output: Output } | undefined;
          };
        }
      `,
    ),
    documented(
      [
        "What a schema produces.",
        "This is what makes the return type worth having: `generateObject` given a `z.object({ orderId: z.string() })` returns `{ orderId: string }`, inferred, with no type argument written at the call site.",
      ],
      dedent`
        export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
          Schema["~standard"]["types"]
        >["output"];
      `,
    ),
  );
}

function seamTypes(): string {
  return sections(
    doc(
      "The model, as narrowly as this pattern needs it.",
      "These are the shapes the mainstream provider abstractions agree on, under the names the chat-model port uses. If you generated that port, its `ChatModel` satisfies `StructuredModel` as it stands — checked with the compiler, including the tool-choice field, where the port is stricter than this seam and assignability runs the way it has to.",
    ),
    documented(
      ["A schema as the wire carries it: a JSON Schema object, unexamined."],
      "export type JsonSchema = Readonly<Record<string, unknown>>;",
    ),
    documented(
      ["A run of text from the model."],
      dedent`
        export interface TextPart {
          readonly type: "text";
          readonly text: string;
        }
      `,
    ),
    documented(
      [
        "The model asking for a tool to be run.",
        "`input` is `unknown` and already a value: an adapter that received it as a JSON string is the thing that parses it, which is why the tool-call strategy below does no parsing of its own.",
      ],
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
      [
        "The answer to a tool call.",
        "`callId` has to be the one the call carried. Both mainstream formats reject a conversation in which an assistant's tool call has no matching result, which is what shapes the correction below.",
      ],
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
      ["One turn of the conversation."],
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
      ["A tool the model may call."],
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
        "Tokens in and out, where the provider reported them.",
        "Present and possibly `undefined` rather than optional, so reading one is a check for `undefined` rather than a check for a missing property.",
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
        "What this pattern sends.",
        "Every field is one the chat-model port's request also has, which is what lets its model be passed straight in.",
      ],
      dedent`
        export interface ModelRequest {
          readonly messages: readonly Message[];
          readonly system?: string;
          readonly tools?: readonly ToolDefinition[];
          readonly toolChoice?:
            | { readonly mode: "auto" }
            | { readonly mode: "none" }
            | { readonly mode: "required" }
            | { readonly mode: "tool"; readonly toolName: string };
          readonly maxOutputTokens?: number;
          readonly temperature?: number;
          readonly signal?: AbortSignal;
          readonly providerOptions?: Readonly<Record<string, unknown>>;
        }
      `,
    ),
    documented(
      [
        "What this pattern reads.",
        "`finishReason` is `string` rather than a union because only one value is ever compared against — `\"length\"`, which turns an unparseable answer from a mystery into \"it was cut off\". Widening it means any producer fits.",
      ],
      dedent`
        export interface ModelAnswer {
          readonly content: readonly (TextPart | ToolCallPart)[];
          readonly finishReason: string;
          readonly usage: Usage;
          readonly warnings: readonly string[];
        }
      `,
    ),
    documented(
      [
        "The model itself.",
        "A method rather than a function property, and one method rather than several: the request carries its own configuration, so there is no model state for a caller to reason about.",
      ],
      dedent`
        export interface StructuredModel {
          generate(request: ModelRequest): Promise<ModelAnswer>;
        }
      `,
    ),
  );
}

function errorTypes(shape: Shape): string {
  return sections(
    documented(
      [
        "The answer was not a value at all.",
        shape.tool
          ? "The model answered without calling the tool, or called it with something that is not a value. Worth another ask with a firmer prompt; not worth handing on."
          : "No JSON in the answer, or JSON that does not parse. The text is carried, because the only useful thing to do with an answer like this is read it.",
        "A cut-off answer lands here too, and says so: `finishReason` was `\"length\"`, and the fix is a larger output limit rather than a different prompt.",
      ],
      dedent`
        export class MalformedObjectError extends Error {
          /** What the model said, for the log. Empty when it said nothing. */
          readonly text: string;
          ${shape.retry ? "readonly attempts: number;" : ""}

          constructor(message: string, text: string${shape.retry ? ", attempts: number" : ""}) {
            super(message);
            this.name = "MalformedObjectError";
            this.text = text;
            ${shape.retry ? "this.attempts = attempts;" : ""}
          }
        }
      `,
    ),
    documented(
      [
        "The value parsed and the schema rejected it.",
        "The issues and the value both travel: the issues say what was wrong, and the value is what to look at when the schema turns out to be the thing that is wrong.",
        shape.retry
          ? "Reaching this means every attempt failed. The issues are the last attempt's."
          : "Not retried, because `onInvalid: \"refuse\"` was chosen at generation time.",
      ],
      dedent`
        export class SchemaViolationError extends Error {
          readonly issues: readonly StandardIssue[];
          /** What was validated, which is the half of the story the issues do not tell. */
          readonly value: unknown;
          ${shape.retry ? "readonly attempts: number;" : ""}

          constructor(
            message: string,
            issues: readonly StandardIssue[],
            value: unknown,
            ${shape.retry ? "attempts: number," : ""}
          ) {
            super(message);
            this.name = "SchemaViolationError";
            this.issues = issues;
            this.value = value;
            ${shape.retry ? "this.attempts = attempts;" : ""}
          }
        }
      `,
    ),
  );
}

function requestType(shape: Shape): string {
  return documented(
    [
      "What to ask for.",
      "`schema` validates the answer and `jsonSchema` is what the model is shown. They have to describe the same thing, and nothing here can check that they do — Standard Schema carries no JSON Schema, so there is nothing to compare against. With Zod, `z.toJSONSchema(schema)` produces the second from the first and the question goes away.",
    ],
    dedent`
      export interface ObjectRequest<Schema extends StandardSchemaV1> {
        readonly schema: Schema;
        /** The same shape as \`schema\`, in the form the model is shown. */
        readonly jsonSchema: JsonSchema;
        /**
         * What the thing being asked for is called.${
          shape.tool ? " The tool's name, so the model reads it." : ""
        }
         */
        readonly name: string;
        ${when(
          shape.tool,
          joinLines(
            "/** What the tool is for, if the name does not say it. */",
            "readonly description?: string;",
          ),
        )}
        readonly messages: readonly Message[];
        readonly system?: string;
        /** Worth setting: a cut-off answer is the failure this pattern reports most. */
        readonly maxOutputTokens?: number;
        readonly temperature?: number;
        readonly signal?: AbortSignal;
        ${when(
          shape.retry,
          joinLines(
            "/** Including the first. `1` disables the retry without regenerating this file. */",
            "readonly maxAttempts?: number;",
          ),
        )}
      }
    `,
  );
}

function resultType(shape: Shape): string {
  return documented(
    [
      "The value, and what it cost.",
      shape.retry
        ? "`attempts` and the summed `usage` are here because a retry loop's cost is not the last call's: two attempts are two calls, both billed, and a caller watching spend needs the total rather than the tail."
        : "`usage` is the call's own, passed through so that a caller watching spend does not need a second path to it.",
    ],
    dedent`
      export interface StructuredResult<Value> {
        readonly value: Value;
        ${shape.retry ? "/** How many calls it took. `1` is the normal case. */\n  readonly attempts: number;" : ""}
        readonly usage: Usage;
        /** The model's own warnings, plus anything the reader had to decide. */
        readonly warnings: readonly string[];
      }
    `,
  );
}

function entryPoint(shape: Shape): string {
  return shape.retry ? retryingEntry(shape) : strictEntry(shape);
}

function entryDoc(shape: Shape): readonly string[] {
  return [
    "Asks the model for a value and returns it validated.",
    "The return type is the schema's own output type, inferred — the point of the exercise. Nothing is cast: the value that comes back is the one `validate` returned, which is the only value in the function that the schema has vouched for.",
    shape.retry
      ? "Throws `SchemaViolationError` if every attempt failed validation, and `MalformedObjectError` if the last answer was not a value at all."
      : "Throws `SchemaViolationError` if the value did not validate, and `MalformedObjectError` if the answer was not a value at all.",
  ];
}

function strictEntry(shape: Shape): string {
  return documented(
    entryDoc(shape),
    dedent`
      export async function generateObject<Schema extends StandardSchemaV1>(
        model: StructuredModel,
        request: ObjectRequest<Schema>,
      ): Promise<StructuredResult<InferOutput<Schema>>> {
        const answer = await model.generate(requestFor(request, request.messages));
        const payload = payloadOf(answer, request.name);

        if (payload.found === false) {
          throw new MalformedObjectError(payload.why, payload.text);
        }

        const validated = await request.schema["~standard"].validate(payload.value);
        if (!accepted(validated)) {
          throw new SchemaViolationError(
            \`the model's answer did not match the schema: \${listOf(validated.issues)}\`,
            validated.issues,
            payload.value,
          );
        }

        return {
          // \`validated.value\`, not \`payload.value\`: a schema may coerce, and the coerced value is the
          // one whose type was promised to the caller.
          value: validated.value as InferOutput<Schema>,
          usage: answer.usage,
          warnings: [...answer.warnings, ...payload.warnings],
        };
      }
    `,
  );
}

function retryingEntry(shape: Shape): string {
  return documented(
    entryDoc(shape),
    dedent`
      export async function generateObject<Schema extends StandardSchemaV1>(
        model: StructuredModel,
        request: ObjectRequest<Schema>,
      ): Promise<StructuredResult<InferOutput<Schema>>> {
        const maxAttempts = Math.max(1, request.maxAttempts ?? 2);
        const warnings: string[] = [];
        const spent: Usage[] = [];
        let messages: readonly Message[] = request.messages;

        for (let attempt = 1; ; attempt += 1) {
          const answer = await model.generate(requestFor(request, messages));
          spent.push(answer.usage);
          warnings.push(...answer.warnings);

          const problem = await problemWith(answer, request, warnings);
          if (problem.kind === "ok") {
            return {
              value: problem.value as InferOutput<Schema>,
              attempts: attempt,
              usage: totalOf(spent),
              warnings,
            };
          }

          if (attempt >= maxAttempts) {
            throw refusalFor(problem, attempt);
          }
          // The failed answer *and* the complaint. A model shown only the complaint has to be told
          // what it said, and the message it needs to see is already in hand.
          messages = [...messages, ...correctionFor(answer, problem, request.name)];
        }
      }
    `,
  );
}

// ---------------------------------------------------------------------------------------------------
// Shaping the request.
// ---------------------------------------------------------------------------------------------------

function requestShaping(shape: Shape): string {
  return shape.tool
    ? documented(
        [
          "The request, as a tool the model is required to call.",
          "`toolChoice` naming the tool rather than `\"required\"`: with one tool declared they mean the same thing today, and they stop meaning the same thing the moment a caller adds a second — at which point a named choice still asks for this one.",
        ],
        dedent`
          function requestFor<Schema extends StandardSchemaV1>(
            request: ObjectRequest<Schema>,
            messages: readonly Message[],
          ): ModelRequest {
            return {
              messages,
              ...(request.system === undefined ? {} : { system: request.system }),
              tools: [
                {
                  name: request.name,
                  ...(request.description === undefined
                    ? {}
                    : { description: request.description }),
                  inputSchema: request.jsonSchema,
                },
              ],
              toolChoice: { mode: "tool", toolName: request.name },
              ...(request.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: request.maxOutputTokens }),
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            };
          }
        `,
      )
    : shape.jsonMode
      ? documented(
          [
            "The request, with a response format the endpoint may or may not honour.",
            "Through `providerOptions` because the port's request has no field for it, and it has none because JSON mode is not part of what every provider offers. The spelling here is the OpenAI-compatible one, which is what an OpenAI, Azure, Gemini-compatibility or LiteLLM endpoint reads.",
          ],
          dedent`
            function requestFor<Schema extends StandardSchemaV1>(
              request: ObjectRequest<Schema>,
              messages: readonly Message[],
            ): ModelRequest {
              return {
                messages,
                ...(request.system === undefined ? {} : { system: request.system }),
                providerOptions: {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: request.name,
                      schema: request.jsonSchema,
                      // The provider rejects a schema it cannot enforce rather than quietly
                      // ignoring half of it, which is the whole reason to prefer this strategy.
                      strict: true,
                    },
                  },
                },
                ...(request.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: request.maxOutputTokens }),
                ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              };
            }
          `,
        )
      : documented(
          [
            "The request, with the schema in the system prompt.",
            "The caller's own system prompt comes first, because it says what the model is; the instruction comes after, because it says what to answer with. Appending rather than replacing means a caller does not have to choose between the two.",
          ],
          dedent`
            function requestFor<Schema extends StandardSchemaV1>(
              request: ObjectRequest<Schema>,
              messages: readonly Message[],
            ): ModelRequest {
              const instruction = [
                \`Answer with a single JSON value named \${request.name} and nothing else:\`,
                "no prose before it, no code fence around it.",
                \`It must satisfy this JSON Schema:\\n\${JSON.stringify(request.jsonSchema)}\`,
              ].join(" ");

              return {
                messages,
                system:
                  request.system === undefined
                    ? instruction
                    : \`\${request.system}\\n\\n\${instruction}\`,
                ...(request.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: request.maxOutputTokens }),
                ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              };
            }
          `,
        );
}

// ---------------------------------------------------------------------------------------------------
// Reading the answer.
// ---------------------------------------------------------------------------------------------------

function payloadReading(shape: Shape): string {
  return sections(
    documented(
      [
        "What the reader found, or why it found nothing.",
        "Checked as `payload.found === false` rather than `!payload.found`. Both narrow under `strict`, and only the comparison narrows in a project with `strictNullChecks` off.",
      ],
      dedent`
        type Payload =
          | {
              readonly found: true;
              readonly value: unknown;
              readonly text: string;
              readonly warnings: readonly string[];
            }
          | { readonly found: false; readonly why: string; readonly text: string };
      `,
    ),
    when(shape.retry, problemTypes(shape)),
    when(shape.retry, problemReader()),
    when(shape.retry, refusalBuilder()),
    shape.tool ? toolPayload() : textPayload(shape),
    when(!shape.tool, textJoin()),
    when(!shape.tool, jsonLocator()),
    when(!shape.tool, balancedScanner()),
  );
}

function problemTypes(shape: Shape): string {
  return documented(
    [
      "One attempt's outcome.",
      "Three cases rather than a boolean, because the complaint sent back differs: a model that answered in prose needs to be told to answer in JSON, and a model that answered in JSON needs to be told which fields were wrong.",
      shape.tool
        ? "`unreadable` covers a model that answered without calling the tool, which is the failure this strategy has."
        : "`unreadable` covers prose with no JSON in it, JSON that does not parse, and an answer cut off mid-object.",
    ],
    dedent`
      type Problem =
        | { readonly kind: "ok"; readonly value: unknown }
        | { readonly kind: "unreadable"; readonly why: string; readonly text: string }
        | {
            readonly kind: "invalid";
            readonly issues: readonly StandardIssue[];
            readonly value: unknown;
          };
    `,
  );
}

function problemReader(): string {
  return documented(
    [
      "One attempt: read the answer, validate what was in it, and say what happened.",
      "Warnings are pushed rather than returned because they accumulate across attempts, and a warning from an attempt that was later corrected is still worth having — it is the one that says the response format was ignored.",
    ],
    dedent`
      async function problemWith<Schema extends StandardSchemaV1>(
        answer: ModelAnswer,
        request: ObjectRequest<Schema>,
        warnings: string[],
      ): Promise<Problem> {
        const payload = payloadOf(answer, request.name);
        if (payload.found === false) {
          return { kind: "unreadable", why: payload.why, text: payload.text };
        }
        warnings.push(...payload.warnings);

        const validated = await request.schema["~standard"].validate(payload.value);
        return accepted(validated)
          ? { kind: "ok", value: validated.value }
          : { kind: "invalid", issues: validated.issues, value: payload.value };
      }
    `,
  );
}

function refusalBuilder(): string {
  return documented(
    [
      "The refusal for a problem that ran out of attempts.",
      "The attempt count is in the message as well as on the error, because the message is what ends up in a log line and \"after 3 attempts\" is the part that tells you the retry was not the missing piece.",
    ],
    dedent`
      function refusalFor(
        problem: Extract<Problem, { kind: "invalid" | "unreadable" }>,
        attempts: number,
      ): Error {
        const tail = attempts > 1 ? \` after \${String(attempts)} attempts\` : "";
        return problem.kind === "invalid"
          ? new SchemaViolationError(
              \`the model's answer did not match the schema\${tail}: \${listOf(problem.issues)}\`,
              problem.issues,
              problem.value,
              attempts,
            )
          : new MalformedObjectError(\`\${problem.why}\${tail}\`, problem.text, attempts);
      }
    `,
  );
}

function toolPayload(): string {
  return documented(
    [
      "The value, out of the call the model was required to make.",
      "No parsing: the input is already a value by the time an adapter has read it. Which is the quiet advantage of this strategy — none of the prose-scraping below is needed, and none of it can go wrong.",
      "A model that answered in text instead is the failure to expect here. Its text is carried, because it usually says why it refused.",
      "Calling the tool twice is the other thing to expect, and it is a warning rather than a failure: parallel tool calls are a feature, and a model that emits two candidate values has still emitted one. The first is used, because it is the one the model committed to, and the warning says the second was dropped — silently discarding it would leave a caller wondering why the answer changed between runs.",
    ],
    dedent`
      function payloadOf(answer: ModelAnswer, name: string): Payload {
        const calls = answer.content.filter(
          (part): part is ToolCallPart => part.type === "tool-call" && part.toolName === name,
        );
        const call = calls[0];

        if (call === undefined) {
          return {
            found: false,
            why:
              answer.finishReason === "length"
                ? \`the answer was cut off before \${name} was called\`
                : \`the model answered without calling \${name}\`,
            text: textOf(answer),
          };
        }

        return {
          found: true,
          value: call.input,
          text: JSON.stringify(call.input),
          warnings:
            calls.length > 1
              ? [\`the model called \${name} \${String(calls.length)} times; the first was used\`]
              : [],
        };
      }

      /** Whatever the model said alongside — or instead of — the call. */
      function textOf(answer: ModelAnswer): string {
        return answer.content
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("");
      }
    `,
  );
}

function textPayload(shape: Shape): string {
  return documented(
    [
      "The value, out of whatever the model said.",
      "Every failure here is named rather than left to `JSON.parse`. \"Unexpected end of JSON input\" is true and useless; \"the answer was cut off mid-JSON\" says which knob to turn.",
      ...(shape.jsonMode
        ? [
            "Prose around the JSON earns a warning rather than a failure. The answer is still usable, and the warning is the only signal a caller gets that the response format did not take effect — which is what happens on an endpoint that accepts the field and ignores it.",
          ]
        : []),
    ],
    dedent`
      function payloadOf(answer: ModelAnswer, name: string): Payload {
        const text = textOf(answer);
        if (text.trim() === "") {
          return {
            found: false,
            why:
              answer.finishReason === "length"
                ? "the answer was cut off before any of it arrived"
                : \`the model answered nothing when asked for \${name}\`,
            text,
          };
        }

        const located = jsonIn(text);
        if (located.kind === "none") {
          return { found: false, why: "no JSON value was found in the answer", text };
        }
        if (located.kind === "unterminated") {
          // Distinct from finding nothing: something was being written and stopped. Only this one is
          // worth asking again with a larger output limit.
          return {
            found: false,
            why:
              answer.finishReason === "length"
                ? "the answer was cut off mid-JSON"
                : "the answer's JSON was never closed",
            text,
          };
        }

        try {
          return {
            found: true,
            value: JSON.parse(located.text) as unknown,
            text,
            warnings: ${
              shape.jsonMode
                ? dedent`
                    located.text === text.trim()
                      ? []
                      : ["the answer had prose around its JSON, so the response format was probably ignored"]
                  `
                : "[]"
            },
          };
        } catch (cause) {
          // Balanced brackets are not valid JSON: a trailing comma or an unquoted key gets this far.
          return { found: false, why: \`the answer was not JSON: \${String(cause)}\`, text };
        }
      }
    `,
  );
}

function textJoin(): string {
  return documented(
    [
      "Everything the model said, as one string.",
      "Joined with nothing between the runs, because they are pieces of one answer and a separator lands in the middle of it.",
    ],
    dedent`
      function textOf(answer: ModelAnswer): string {
        return answer.content
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("");
      }
    `,
  );
}

function jsonLocator(): string {
  return sections(
    documented(
      ["Where the JSON is, or why it is nowhere."],
      dedent`
        type Located =
          | { readonly kind: "found"; readonly text: string }
          | { readonly kind: "none" }
          | { readonly kind: "unterminated" };
      `,
    ),
    documented(
      [
        "The first JSON value in some text, code fence and all.",
        "A fence is looked for first because a fenced block is the model being explicit about where the answer is, and prose outside it can contain braces. Inside the fence, or in the whole answer if there is none, the search is for the first `{` or `[`.",
      ],
      dedent`
        function jsonIn(text: string): Located {
          const fenced = /\`\`\`(?:[A-Za-z]+)?\\s*\\n([\\s\\S]*?)\\n?\`\`\`/.exec(text);
          const body = fenced?.[1] ?? text;
          const opensAt = body.search(/[{[]/);

          if (opensAt === -1) {
            return { kind: "none" };
          }

          const closesAt = closingOf(body, opensAt);
          return closesAt === undefined
            ? { kind: "unterminated" }
            : { kind: "found", text: body.slice(opensAt, closesAt + 1) };
        }
      `,
    ),
  );
}

function balancedScanner(): string {
  return documented(
    [
      "Where the value opening at `from` ends.",
      "Counting brackets is not enough on its own: a `}` inside a string closes nothing, and a `\\\"` inside a string does not end it. Both appear in real answers — an order id with a brace in it is all it takes — and a reader that ignores them truncates the value and then blames the model.",
      "Not a JSON parser. It finds where the value ends; `JSON.parse` decides whether it was one.",
    ],
    dedent`
      function closingOf(text: string, from: number): number | undefined {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let at = from; at < text.length; at += 1) {
          const character = text.charAt(at);

          if (inString) {
            if (escaped) {
              escaped = false;
            } else if (character === "\\\\") {
              escaped = true;
            } else if (character === '"') {
              inString = false;
            }
            continue;
          }

          if (character === '"') {
            inString = true;
            continue;
          }
          if (character === "{" || character === "[") {
            depth += 1;
            continue;
          }
          if (character === "}" || character === "]") {
            depth -= 1;
            if (depth === 0) {
              return at;
            }
          }
        }

        return undefined;
      }
    `,
  );
}

// ---------------------------------------------------------------------------------------------------
// The correction.
// ---------------------------------------------------------------------------------------------------

function correction(shape: Shape): string {
  return documented(
    [
      "What to send back after a wrong answer.",
      shape.tool
        ? "Two messages: the assistant's failed call, and the complaint *as that call's result*. Not a user message — both mainstream wire formats reject a request in which an assistant tool call has no matching tool result, so a user message here fails with a provider error that says nothing about schemas. `failed: true` is what says the result is a complaint rather than an answer."
        : "Two messages: the assistant's own answer, so the model can see what it said, and a user message naming what was wrong with it.",
      "The complaint names paths and messages and asks again. It does not restate the schema — that is already in the conversation, and repeating it is tokens spent to say something the model can see.",
    ],
    dedent`
      function correctionFor(
        answer: ModelAnswer,
        problem: Extract<Problem, { kind: "invalid" | "unreadable" }>,
        name: string,
      ): readonly Message[] {
        const complaint =
          problem.kind === "invalid"
            ? \`That did not match the schema. Fix these and answer again:\\n\${listOf(problem.issues)}\`
            : \`\${problem.why}. Answer again with a single JSON value for \${name}.\`;
        ${
          shape.tool
            ? dedent`
                const call = answer.content.find(
                  (part): part is ToolCallPart =>
                    part.type === "tool-call" && part.toolName === name,
                );

                if (call === undefined) {
                  // Nothing to answer, because the model never called it. A plain user message is
                  // then both legal and the only option.
                  return [
                    ...echoOf(answer),
                    { role: "user", content: [{ type: "text", text: complaint }] },
                  ];
                }

                return [
                  { role: "assistant", content: answer.content },
                  {
                    role: "tool",
                    content: [
                      {
                        type: "tool-result",
                        callId: call.callId,
                        toolName: name,
                        output: complaint,
                        failed: true,
                      },
                    ],
                  },
                ];
              `
            : dedent`
                return [
                  ...echoOf(answer),
                  { role: "user", content: [{ type: "text", text: complaint }] },
                ];
              `
        }
      }

      /**
       * The model's own answer, echoed back — unless it said nothing, in which case an empty
       * assistant turn is a message some providers reject.
       */
      function echoOf(answer: ModelAnswer): readonly Message[] {
        return answer.content.length === 0
          ? []
          : [{ role: "assistant", content: answer.content }];
      }
    `,
  );
}

function issueRendering(): string {
  return sections(
    documented(
      [
        "The issues as lines a model can act on.",
        "One line per issue, path first. A model given `total: expected a number` fixes one field; a model given the schema again re-reads all of it.",
      ],
      dedent`
        function listOf(issues: readonly StandardIssue[]): string {
          return issues.map((issue) => \`- \${pathOf(issue)}: \${issue.message}\`).join("\\n");
        }
      `,
    ),
    documented(
      [
        "One issue's path, in the notation the value is written in.",
        "`lines[0].sku`, not `lines.0.sku`: the first is how the caller would reach the field and how a model reads it back. A segment can be a bare key or an object wrapping one, since the specification allows both and the libraries differ.",
        "An issue with no path at all is the value itself, which is `(root)` rather than an empty string — an empty path renders as nothing and reads as a formatting bug.",
      ],
      dedent`
        function pathOf(issue: StandardIssue): string {
          const segments = issue.path ?? [];
          if (segments.length === 0) {
            return "(root)";
          }

          let rendered = "";
          for (const segment of segments) {
            const key = typeof segment === "object" ? segment.key : segment;
            if (typeof key === "number") {
              rendered += \`[\${String(key)}]\`;
            } else {
              rendered += rendered === "" ? String(key) : \`.\${String(key)}\`;
            }
          }

          return rendered;
        }
      `,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------------------------------

function tests(context: RenderContext, shape: Shape): string {
  const spec = siblingSpecifier(context.conventions, STEM);

  return sections(
    doc(
      "The pattern, against scripted models.",
      "A model is a function returning a recorded answer, so every case here is a shape a real provider produces and none of them go near a network. What is being pinned is the reading of an answer, the request that asked for it, and the correction that follows a wrong one.",
    ),
    frameworkImports(context.conventions),
    importsFrom(context.conventions, spec, {
      values: ["generateObject", "MalformedObjectError", "SchemaViolationError"],
      types: [
        "JsonSchema",
        ...(shape.retry ? ["Message"] : []),
        "StandardIssue",
        "ModelAnswer",
        "ModelRequest",
        "StandardSchemaV1",
        "StructuredModel",
        "StructuredResult",
        "Usage",
      ],
    }),
    fixtures(shape),
    happyCases(shape),
    shape.tool ? callReadingCases(shape) : textReadingCases(shape),
    shape.retry ? retryCases(shape) : refusalCases(shape),
    pathCases(shape),
  );
}

function fixtures(shape: Shape): string {
  return sections(
    doc(
      "A schema, a model that answers from a script, and a way to catch a refusal.",
      "The schema is hand-written for the reason the emitted file has no dependencies, and its issues carry both path notations the specification allows so that the rendering of them is pinned here rather than assumed.",
    ),
    dedent`
      const USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

      interface Order {
        readonly orderId: string;
        readonly total: number;
      }

      const OrderSchema: StandardSchemaV1<unknown, Order> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              // No path at all, which is how a schema says the value itself is wrong.
              return { issues: [{ message: "expected an object" }] };
            }
            const record = value as Record<string, unknown>;
            const issues: StandardIssue[] = [];

            if (typeof record["orderId"] !== "string") {
              issues.push({ message: "expected a string", path: ["orderId"] });
            }
            if (typeof record["total"] !== "number") {
              // The wrapped form, and a numeric index: both are legal, and a renderer that
              // handles only bare keys turns this into "[object Object]".
              issues.push({ message: "expected a number", path: [{ key: "lines" }, { key: 0 }, "total"] });
            }

            return issues.length > 0
              ? { issues }
              : {
                  value: {
                    orderId: record["orderId"] as string,
                    total: record["total"] as number,
                  },
                };
          },
        },
      };

      const JSON_SCHEMA: JsonSchema = {
        type: "object",
        properties: { orderId: { type: "string" }, total: { type: "number" } },
        required: ["orderId", "total"],
      };

      function textAnswer(
        text: string,
        finishReason = "stop",
        usage: Usage = USAGE,
      ): ModelAnswer {
        return { content: [{ type: "text", text }], finishReason, usage, warnings: [] };
      }

      function callAnswer(input: unknown, toolName = "emitOrder"): ModelAnswer {
        return {
          content: [{ type: "tool-call", callId: "call-1", toolName, input }],
          finishReason: "tool-calls",
          usage: USAGE,
          warnings: [],
        };
      }

      /**
       * A model that answers from a list, and keeps every request it was given.
       *
       * The last answer repeats, so a case that expects one attempt does not have to say what a
       * second would have received.
       */
      function scripted(...answers: readonly ModelAnswer[]): {
        readonly model: StructuredModel;
        readonly seen: readonly ModelRequest[];
      } {
        const seen: ModelRequest[] = [];
        let at = 0;

        return {
          seen,
          model: {
            generate: (request: ModelRequest) => {
              seen.push(request);
              const answer = answers[Math.min(at, answers.length - 1)];
              at += 1;
              if (answer === undefined) {
                throw new Error("the script was empty");
              }
              return Promise.resolve(answer);
            },
          },
        };
      }

      /**
       * One ask, with the boilerplate of a request behind it.
       *
       * The return type is written out rather than inferred, which is the assertion: \`Order\` is
       * what the schema declares, and nothing in the emitted file casts its way there.
       */
      function ask(
        model: StructuredModel,
        overrides: { readonly system?: string;${
          shape.retry ? " readonly maxAttempts?: number;" : ""
        } } = {},
      ): Promise<StructuredResult<Order>> {
        return generateObject(model, {
          schema: OrderSchema,
          jsonSchema: JSON_SCHEMA,
          name: "emitOrder",
          messages: [{ role: "user", content: [{ type: "text", text: "note" }] }],
          ...overrides,
        });
      }

      /**
       * The error a call raised, or a failure saying it raised none.
       *
       * Returned rather than asserted so that a case can check the type *and* what it carries.
       */
      async function refusalFrom(run: () => Promise<unknown>): Promise<unknown> {
        try {
          await run();
        } catch (error) {
          return error;
        }
        throw new Error("expected a refusal, and nothing was thrown");
      }
    `,
    when(
      shape.retry,
      dedent`
        /** What the model was told after a wrong answer, wherever the complaint travelled. */
        function complaintIn(messages: readonly Message[]): string {
          const last = messages.at(-1);
          if (last === undefined) {
            return "";
          }
          if (last.role === "tool") {
            return String(last.content[0]?.output ?? "");
          }
          return last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
        }
      `,
    ),
  );
}

function happyCases(shape: Shape): string {
  const valid = rightAnswer(shape);

  return describeBlock(
    "asking for a value",
    testCase(
      "the answer comes back as the schema's own type",
      dedent`
        const found = await ask(scripted(${valid}).model);

        // Not a cast anywhere above: this is what \`validate\` returned, and its type is the one the
        // schema declared. A field that was not in the schema would not compile here.
        const order: Order = found.value;
        expect(order).toEqual({ orderId: "A-17", total: 12 });
        ${shape.retry ? "expect(found.attempts).toBe(1);" : ""}
        expect(found.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
        expect(found.warnings).toEqual([]);
      `,
    ),
    testCase(
      shape.tool
        ? "the request declares the tool and requires it by name"
        : shape.jsonMode
          ? "the request carries the response format the endpoint reads"
          : "the request puts the schema in the system prompt",
      shape.tool
        ? dedent`
            const asked = scripted(${valid});
            await ask(asked.model);

            const sent = asked.seen[0];
            expect(sent?.tools).toEqual([{ name: "emitOrder", inputSchema: JSON_SCHEMA }]);
            // Named rather than \`"required"\`: with a second tool declared those stop meaning the
            // same thing, and this one keeps meaning what it says.
            expect(sent?.toolChoice).toEqual({ mode: "tool", toolName: "emitOrder" });
          `
        : shape.jsonMode
          ? dedent`
              const asked = scripted(${valid});
              await ask(asked.model);

              // In \`providerOptions\` because the request type has no field for it: JSON mode is not
              // something every provider offers, so it is not part of the shared shape.
              expect(asked.seen[0]?.providerOptions).toEqual({
                response_format: {
                  type: "json_schema",
                  json_schema: { name: "emitOrder", schema: JSON_SCHEMA, strict: true },
                },
              });
            `
          : dedent`
              const asked = scripted(${valid});
              await ask(asked.model, { system: "You read shipping notes." });

              const system = asked.seen[0]?.system ?? "";
              // The caller's prompt first: it says what the model is, and the instruction says what
              // to answer with. Replacing it would silently drop the caller's own words.
              expect(system.startsWith("You read shipping notes.")).toBe(true);
              expect(system).toContain(JSON.stringify(JSON_SCHEMA));
            `,
    ),
    testCase(
      "a schema that coerces hands back what it produced",
      dedent`
        // The value the schema returned, not the value that was parsed. A schema is allowed to
        // trim, default or convert, and the caller was promised the result of doing so.
        const Coercing: StandardSchemaV1<unknown, Order> = {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: (value: unknown) => ({
              value: {
                orderId: String((value as { orderId?: unknown }).orderId ?? "").trim(),
                total: Number((value as { total?: unknown }).total ?? 0),
              },
            }),
          },
        };

        const found = await generateObject(scripted(${
          shape.tool
            ? 'callAnswer({ orderId: " A-17 ", total: "12" })'
            : 'textAnswer(\'{"orderId":" A-17 ","total":"12"}\')'
        }).model, {
          schema: Coercing,
          jsonSchema: JSON_SCHEMA,
          name: "emitOrder",
          messages: [{ role: "user", content: [{ type: "text", text: "note" }] }],
        });

        expect(found.value).toEqual({ orderId: "A-17", total: 12 });
      `,
    ),
    testCase(
      "the model's own warnings are not lost",
      dedent`
        const noisy: ModelAnswer = {
          ...${valid},
          warnings: ["the provider renamed a field"],
        };

        const found = await ask(scripted(noisy).model);

        expect(found.warnings).toEqual(["the provider renamed a field"]);
      `,
    ),
  );
}

function textReadingCases(shape: Shape): string {
  return describeBlock(
    "finding the value in what the model said",
    testCase(
      "a fenced block inside prose is still an answer",
      dedent`
        const found = await ask(
          scripted(
            textAnswer('Sure!\\n\`\`\`json\\n{"orderId":"A-17","total":12}\\n\`\`\`\\nAnything else?'),
          ).model,
        );

        expect(found.value).toEqual({ orderId: "A-17", total: 12 });
        ${
          shape.jsonMode
            ? dedent`
                // And a warning, because the answer was asked for as bare JSON. A provider that
                // accepts the response format and ignores it is otherwise invisible.
                expect(found.warnings).toHaveLength(1);
                expect(found.warnings[0]).toContain("response format");
              `
            : dedent`
                // No warning: prose is what asking in the prompt gets, and saying so on every
                // successful call would make the field useless.
                expect(found.warnings).toEqual([]);
              `
        }
      `,
    ),
    testCase(
      "a brace in the prose around a fenced block is not mistaken for the answer",
      dedent`
        // The fence is looked at first for exactly this: the model wrote a brace in its preamble,
        // and a reader that scans the whole answer for the first \`{\` finds that one.
        const found = await ask(
          scripted(
            textAnswer(
              'Here it is {see below}:\\n\`\`\`json\\n{"orderId":"A-17","total":12}\\n\`\`\`',
            ),
          ).model${once(shape)},
        );

        expect(found.value).toEqual({ orderId: "A-17", total: 12 });
      `,
    ),
    testCase(
      "a brace inside a string does not end the object",
      dedent`
        // An order id with a brace in it is all this takes, and a reader that counts brackets
        // without tracking strings truncates the value and then blames the model.
        const found = await ask(scripted(textAnswer('{"orderId":"A-}-17","total":12}')).model);

        expect(found.value.orderId).toBe("A-}-17");
      `,
    ),
    testCase(
      "an escaped quote does not end the string",
      dedent`
        const found = await ask(
          scripted(textAnswer('{"orderId":"A-\\\\"-17","total":12}')).model,
        );

        expect(found.value.orderId).toBe('A-"-17');
      `,
    ),
    testCase(
      "prose with no JSON in it is refused",
      dedent`
        const refusal = await refusalFrom(() =>
          ask(scripted(textAnswer("I would rather not.")).model${once(shape)}),
        );

        expect(refusal).toBeInstanceOf(MalformedObjectError);
        // The text, because it usually says why.
        expect((refusal as MalformedObjectError).text).toBe("I would rather not.");
      `,
    ),
    testCase(
      "an answer cut off mid-JSON says so, rather than quoting a parse error",
      dedent`
        const refusal = await refusalFrom(() =>
          ask(scripted(textAnswer('{"orderId":"A-1', "length")).model${once(shape)}),
        );

        // "Unexpected end of JSON input" is true and tells a caller nothing. This says which knob
        // to turn.
        expect((refusal as Error).message).toContain("cut off");
      `,
    ),
    testCase(
      "brackets that balance but are not JSON are refused as not JSON",
      dedent`
        // A trailing comma. The scanner finds where the value ends; \`JSON.parse\` decides whether
        // it was one, and the two answers differ.
        const refusal = await refusalFrom(() =>
          ask(scripted(textAnswer('{"orderId":"A-17","total":12,}')).model${once(shape)}),
        );

        expect(refusal).toBeInstanceOf(MalformedObjectError);
        expect((refusal as Error).message).toContain("not JSON");
      `,
    ),
    testCase(
      "an answer with nothing in it says so, rather than reporting no JSON",
      dedent`
        const refusal = await refusalFrom(() =>
          ask(scripted(textAnswer("   ")).model${once(shape)}),
        );

        expect(refusal).toBeInstanceOf(MalformedObjectError);
        // "No JSON was found" is true of an empty answer and describes the wrong problem: nothing
        // arrived at all, and that is a different thing to go and look at.
        expect((refusal as Error).message).toContain("answered nothing");
      `,
    ),
  );
}

function callReadingCases(shape: Shape): string {
  return describeBlock(
    "finding the value in the call",
    testCase(
      "the call's input is taken as a value, not parsed",
      dedent`
        // Nested, and with a string that would break a brace-counting reader if this strategy had
        // to read prose at all. It does not: the adapter already turned the wire into a value.
        const found = await generateObject(
          scripted(callAnswer({ orderId: "A-}-17", total: 12, lines: [{ sku: "s" }] })).model,
          {
            schema: OrderSchema,
            jsonSchema: JSON_SCHEMA,
            name: "emitOrder",
            messages: [{ role: "user", content: [{ type: "text", text: "note" }] }],
          },
        );

        expect(found.value).toEqual({ orderId: "A-}-17", total: 12 });
      `,
    ),
    testCase(
      "an answer in text instead of a call is refused, and its text kept",
      dedent`
        const refusal = await refusalFrom(() =>
          ask(scripted(textAnswer("I would rather not.")).model${once(shape)}),
        );

        expect(refusal).toBeInstanceOf(MalformedObjectError);
        expect((refusal as Error).message).toContain("emitOrder");
        // What it said instead, which is where the reason is.
        expect((refusal as MalformedObjectError).text).toBe("I would rather not.");
      `,
    ),
    testCase(
      "a call to some other tool is not the answer",
      dedent`
        // A model with a conversation behind it can call something else. Matching on the name
        // rather than taking the first call is what keeps that from being read as the value.
        const refusal = await refusalFrom(() =>
          ask(scripted(callAnswer({ orderId: "A-17", total: 12 }, "lookupOrder")).model${once(shape)}),
        );

        expect(refusal).toBeInstanceOf(MalformedObjectError);
      `,
    ),
    testCase(
      "an answer cut off before the call says so",
      dedent`
        const refusal = await refusalFrom(() =>
          ask(scripted(textAnswer("Let me look th", "length")).model${once(shape)}),
        );

        expect((refusal as Error).message).toContain("cut off");
      `,
    ),
    testCase(
      "two calls to the same tool use the first and say the second was dropped",
      dedent`
        // Parallel tool calls are a feature, so this is not a contradiction — but a caller whose
        // answer changes between runs deserves to know a second candidate existed.
        const twice: ModelAnswer = {
          content: [
            { type: "tool-call", callId: "call-1", toolName: "emitOrder", input: { orderId: "A-17", total: 12 } },
            { type: "tool-call", callId: "call-2", toolName: "emitOrder", input: { orderId: "B-2", total: 3 } },
          ],
          finishReason: "tool-calls",
          usage: USAGE,
          warnings: [],
        };

        const found = await ask(scripted(twice).model);

        expect(found.value.orderId).toBe("A-17");
        expect(found.warnings).toHaveLength(1);
        expect(found.warnings[0]).toContain("2 times");
      `,
    ),
  );
}

function retryCases(shape: Shape): string {
  const wrong = wrongAnswer(shape);
  const right = rightAnswer(shape);

  return describeBlock(
    "when the answer is wrong",
    testCase(
      "a wrong answer is asked again, and the second one is the result",
      dedent`
        const asked = scripted(${wrong}, ${right});

        const found = await ask(asked.model);

        expect(found.value).toEqual({ orderId: "A-17", total: 12 });
        expect(found.attempts).toBe(2);
        expect(asked.seen).toHaveLength(2);
        // Two calls, two bills. Reporting the successful attempt's usage alone would understate
        // exactly the requests that cost the most.
        expect(found.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
      `,
    ),
    testCase(
      shape.tool
        ? "the complaint travels as the failed call's result"
        : "the complaint travels as a user message after the model's own words",
      shape.tool
        ? dedent`
            const asked = scripted(${wrong}, ${right});
            await ask(asked.model);

            const sent = asked.seen[1]?.messages ?? [];
            // The failed call, echoed, so the model can see what it sent.
            expect(sent[1]?.role).toBe("assistant");
            // And the complaint as that call's result, carrying its id. A user message here is
            // rejected by both mainstream formats before the model reads a word of it.
            const result = sent[2];
            expect(result?.role).toBe("tool");
            expect(result?.content[0]).toEqual({
              type: "tool-result",
              callId: "call-1",
              toolName: "emitOrder",
              output: complaintIn(sent),
              failed: true,
            });
          `
        : dedent`
            const asked = scripted(${wrong}, ${right});
            await ask(asked.model);

            const sent = asked.seen[1]?.messages ?? [];
            // Its own answer first: a model told only what was wrong has to be told what it said.
            expect(sent[1]).toEqual({
              role: "assistant",
              content: [{ type: "text", text: '{"orderId":17}' }],
            });
            expect(sent[2]?.role).toBe("user");
          `,
    ),
    testCase(
      "the complaint names the fields and where they were",
      dedent`
        const asked = scripted(${wrong}, ${right});
        await ask(asked.model);

        const complaint = complaintIn(asked.seen[1]?.messages ?? []);
        // Whole lines, bullet and all, so that a path rendered with a stray leading dot fails here
        // rather than passing a substring check that never looked at the front of it.
        expect(complaint).toContain("- orderId: expected a string");
        // \`lines[0].total\`, not \`lines.0.total\`: the notation the value is written in, which is
        // also the one a model reads back correctly.
        expect(complaint).toContain("- lines[0].total: expected a number");
        // Not the schema again — it is already in the conversation, and repeating it is tokens
        // spent to say something the model can see.
        expect(complaint).toContain("Fix these");
      `,
    ),
    testCase(
      "an unreadable answer is asked again too, with a different complaint",
      dedent`
        const asked = scripted(${
          shape.tool ? 'textAnswer("I would rather not.")' : 'textAnswer("No JSON here.")'
        }, ${right});

        const found = await ask(asked.model);

        expect(found.value.orderId).toBe("A-17");
        // A model that answered in prose needs to be told to answer in JSON; one that answered in
        // JSON needs to be told which fields were wrong. Those are different sentences.
        expect(complaintIn(asked.seen[1]?.messages ?? [])).toContain("Answer again");
      `,
    ),
    testCase(
      "an answer with no content at all is not echoed back as an empty turn",
      dedent`
        // Some providers reject an assistant message with nothing in it, so a model that returned
        // nothing must not have that nothing sent back to it.
        const silent: ModelAnswer = {
          content: [],
          finishReason: "stop",
          usage: USAGE,
          warnings: [],
        };

        const asked = scripted(silent, ${right});

        const found = await ask(asked.model);

        expect(found.value.orderId).toBe("A-17");
        const sent = asked.seen[1]?.messages ?? [];
        expect(sent).toHaveLength(2);
        expect(sent[1]?.role).toBe("user");
      `,
    ),
    testCase(
      "running out of attempts refuses with the last attempt's issues",
      dedent`
        const asked = scripted(${wrong});

        const refusal = await refusalFrom(() => ask(asked.model, { maxAttempts: 3 }));

        expect(refusal).toBeInstanceOf(SchemaViolationError);
        const violation = refusal as SchemaViolationError;
        expect(violation.attempts).toBe(3);
        expect(asked.seen).toHaveLength(3);
        expect(violation.issues).toHaveLength(2);
        // The value as well as the issues: when the schema is the thing that is wrong, this is the
        // only place that says so.
        expect(violation.value).toEqual(${
          shape.tool ? '{ orderId: 17, total: "twelve" }' : "{ orderId: 17 }"
        });
        expect(violation.message).toContain("after 3 attempts");
      `,
    ),
    testCase(
      "one attempt asks once",
      dedent`
        const asked = scripted(${wrong});

        await refusalFrom(() => ask(asked.model, { maxAttempts: 1 }));

        // \`maxAttempts: 1\` turns the retry off without regenerating the file, and the message
        // does not claim a number of attempts nobody asked for.
        expect(asked.seen).toHaveLength(1);
      `,
    ),
    testCase(
      "an attempt that reported no usage makes the total unknown rather than wrong",
      dedent`
        const unmetered: ModelAnswer = {
          ...${wrong},
          usage: { inputTokens: undefined, outputTokens: undefined },
        };

        const found = await ask(scripted(unmetered, ${right}).model);

        // A lower bound presented as a number is worse than no number: it is a figure that ends up
        // in a bill.
        expect(found.usage.inputTokens).toBeUndefined();
        expect(found.usage.outputTokens).toBeUndefined();
      `,
    ),
  );
}

function refusalCases(shape: Shape): string {
  return describeBlock(
    "when the answer is wrong",
    testCase(
      "a value the schema rejects is refused at once, with the issues and the value",
      dedent`
        const asked = scripted(${wrongAnswer(shape)});

        const refusal = await refusalFrom(() => ask(asked.model));

        expect(refusal).toBeInstanceOf(SchemaViolationError);
        const violation = refusal as SchemaViolationError;
        expect(violation.issues).toHaveLength(2);
        // What was validated, which is the half of the story the issues do not tell.
        expect(violation.value).toEqual(${wrongValue(shape)});
        // Once. \`onInvalid: "retry"\` is the generated shape that asks again; this one does not.
        expect(asked.seen).toHaveLength(1);
      `,
    ),
    testCase(
      "the refusal names the fields and where they were",
      dedent`
        const refusal = await refusalFrom(() =>
          ask(scripted(${wrongAnswer(shape)}).model),
        );

        // Whole lines, bullet and all, so that a path rendered with a stray leading dot fails here.
        expect((refusal as Error).message).toContain("- orderId: expected a string");
        // \`lines[0].total\`, not \`lines.0.total\`: the notation the value is written in.
        expect((refusal as Error).message).toContain("- lines[0].total: expected a number");
      `,
    ),
  );
}

function pathCases(shape: Shape): string {
  return describeBlock(
    "an issue about the value itself",
    testCase(
      "a value that is not an object at all is reported against the root",
      dedent`
        // An issue with no path is about the value rather than a field in it. Rendering that as an
        // empty string reads as a formatting bug in whatever prints it.
        const refusal = await refusalFrom(() =>
          ask(scripted(${shape.tool ? "callAnswer([1, 2, 3])" : "textAnswer('[1,2,3]')"}).model${once(shape)}),
        );

        expect((refusal as Error).message).toContain("- (root): expected an object");
      `,
    ),
  );
}

/** `ask`'s second argument when a case wants exactly one attempt, and nothing when it cannot retry. */
function once(shape: Shape): string {
  return shape.retry ? ", { maxAttempts: 1 }" : "";
}

/** A wrong answer, in whichever form this strategy reads. */
function wrongAnswer(shape: Shape): string {
  return shape.tool
    ? 'callAnswer({ orderId: 17, total: "twelve" })'
    : "textAnswer('{\"orderId\":17}')";
}

/** The value a wrong answer carried, which is what the refusal should hand back. */
function wrongValue(shape: Shape): string {
  return shape.tool ? '{ orderId: 17, total: "twelve" }' : "{ orderId: 17 }";
}

/** A valid answer, in whichever form this strategy reads. */
function rightAnswer(shape: Shape): string {
  return shape.tool
    ? 'callAnswer({ orderId: "A-17", total: 12 })'
    : 'textAnswer(\'{"orderId":"A-17","total":12}\')';
}

/**
 * A `describe` with its cases inside it, one blank line apart.
 *
 * `joinLines` for the cases would run them together, and a suite whose tests touch is the one shape of
 * generated output that reviewers reliably complain about. Prettier will not fix it either: it
 * preserves blank lines rather than inserting them.
 */
function describeBlock(title: string, ...cases: readonly string[]): string {
  const body = cases.filter((one) => one.trim() !== "").join("\n\n");
  return body === ""
    ? ""
    : joinLines(`describe(${JSON.stringify(title)}, () => {`, body, "});");
}

function testCase(title: string, body: string): string {
  return joinLines(
    `  it(${JSON.stringify(title)}, async () => {`,
    ...body.split("\n").map((line) => (line === "" ? "" : `    ${line}`)),
    "  });",
  );
}

// ---------------------------------------------------------------------------------------------------
// The example: one extraction, with a schema written by hand and a schema library dropped in.
// ---------------------------------------------------------------------------------------------------

function example(context: RenderContext, shape: Shape): string {
  const spec = siblingSpecifier(context.conventions, STEM);

  return sections(
    doc(
      "Pulling a typed value out of a model.",
      "The schema here is written by hand, because this file imports nothing. In real code it is one line of Zod, Valibot or ArkType and everything else below is unchanged — that is the point of the interface it satisfies.",
    ),
    importsFrom(context.conventions, spec, {
      values: ["generateObject", "MalformedObjectError", "SchemaViolationError"],
      types: [
        "JsonSchema",
        "StandardIssue",
        "StandardSchemaV1",
        "StructuredModel",
        "StructuredResult",
      ],
    }),
    documented(
      ["What is being asked for."],
      dedent`
        export interface Order {
          readonly orderId: string;
          readonly total: number;
          readonly currency: "GBP" | "USD";
        }
      `,
    ),
    documented(
      [
        "The schema, without a schema library.",
        "Fifteen lines, and worth reading once even if you will never write one: this is all the interface asks for, which is why a Zod schema satisfies it without adapting. `z.object({ orderId: z.string(), ... })` goes here instead and the rest of this file does not change.",
        "The interface's `types` property is left out, which is legal: it exists only to carry the input and output types, and the annotation above already says what they are. A schema library fills it in instead, which is how `z.object({ ... })` infers its output without being annotated at all.",
      ],
      dedent`
        export const OrderSchema: StandardSchemaV1<unknown, Order> = {
          "~standard": {
            version: 1,
            vendor: "by-hand",
            validate: (value: unknown) => {
              const issues: StandardIssue[] = [];
              const record = (typeof value === "object" && value !== null ? value : {}) as Record<
                string,
                unknown
              >;

              if (typeof record["orderId"] !== "string") {
                issues.push({ message: "expected a string", path: ["orderId"] });
              }
              if (typeof record["total"] !== "number") {
                issues.push({ message: "expected a number", path: ["total"] });
              }
              if (record["currency"] !== "GBP" && record["currency"] !== "USD") {
                issues.push({ message: 'expected "GBP" or "USD"', path: ["currency"] });
              }

              return issues.length > 0
                ? { issues }
                : {
                    value: {
                      orderId: record["orderId"] as string,
                      total: record["total"] as number,
                      currency: record["currency"] as Order["currency"],
                    },
                  };
            },
          },
        };
      `,
    ),
    documented(
      [
        "The same shape again, in the form the model is shown.",
        "Two declarations of one thing, which is the cost of Standard Schema carrying no JSON Schema. With Zod this is `z.toJSONSchema(OrderSchema)` and there is only one.",
      ],
      dedent`
        export const ORDER_JSON_SCHEMA: JsonSchema = {
          type: "object",
          properties: {
            orderId: { type: "string" },
            total: { type: "number" },
            currency: { type: "string", enum: ["GBP", "USD"] },
          },
          required: ["orderId", "total", "currency"],
          additionalProperties: false,
        };
      `,
    ),
    documented(
      [
        "Asks the model for an order and returns it, or says what went wrong.",
        "The two failures are worth telling apart, which is why they are two classes. A cut-off answer is worth asking for again with a larger limit; a value the schema rejected is not — either the prompt or the schema is wrong, and repeating the call cannot tell you which.",
      ],
      dedent`
        export async function extractOrder(
          model: StructuredModel,
          note: string,
        ): Promise<StructuredResult<Order> | undefined> {
          try {
            const found = await generateObject(model, {
              schema: OrderSchema,
              jsonSchema: ORDER_JSON_SCHEMA,
              name: "emitOrder",
              ${when(shape.tool, '// Read by the model, so it says what the tool is for.\n      description: "Record the order described in the note.",')}
              system: "You read shipping notes and record the order in them.",
              messages: [{ role: "user", content: [{ type: "text", text: note }] }],
              // The failure this reports most is an answer that ran out of room.
              maxOutputTokens: 512,
              // Nothing creative is being asked for.
              temperature: 0,
              ${when(shape.retry, "// One retry. The first attempt is included in the count.\n      maxAttempts: 2,")}
            });

            // \`found.value.total\` is a number here, and \`found.value.currency\` is the union —
            // inferred from the schema, with no type argument written above.
            report(\`\${found.value.orderId}: \${found.value.total.toFixed(2)} \${found.value.currency}\`);
            ${
              shape.retry
                ? "if (found.attempts > 1) {\n        // Worth logging: a model that needs two goes at a schema is a prompt worth revisiting.\n        report(`it took ${String(found.attempts)} attempts`);\n      }"
                : ""
            }
            for (const warning of found.warnings) {
              report(warning);
            }

            return found;
          } catch (error) {
            if (error instanceof SchemaViolationError) {
              // The issues say what was wrong; the value says whether the schema was.
              report(\`the model's order did not fit: \${error.message}\`);
              report(JSON.stringify(error.value));
              return undefined;
            }
            if (error instanceof MalformedObjectError) {
              report(\`no order in the answer: \${error.message}\`);
              report(error.text);
              return undefined;
            }
            // A cancelled request, a transport failure, anything else: not this function's to
            // interpret.
            throw error;
          }
        }
      `,
    ),
    documented(
      ["Where this example's output goes. A logger, a span, a test spy."],
      dedent`
        function report(line: string): void {
          void line;
        }
      `,
    ),
  );
}

function usageTotals(): string {
  return sections(
    documented(
      [
        "What every attempt cost, together.",
        "A retry is a second call and a second bill. Reporting only the successful attempt's usage would understate the cost of exactly the requests that cost the most.",
      ],
      dedent`
        function totalOf(spent: readonly Usage[]): Usage {
          return {
            inputTokens: sumOf(spent, "inputTokens"),
            outputTokens: sumOf(spent, "outputTokens"),
          };
        }
      `,
    ),
    documented(
      [
        "A total, or nothing at all.",
        "One attempt that did not report makes the sum a lower bound, and a lower bound presented as a number is worse than no number: it is a figure a caller would put in a bill.",
      ],
      dedent`
        function sumOf(spent: readonly Usage[], field: keyof Usage): number | undefined {
          let total = 0;
          for (const usage of spent) {
            const reported = usage[field];
            if (reported === undefined) {
              return undefined;
            }
            total += reported;
          }
          return total;
        }
      `,
    ),
  );
}
