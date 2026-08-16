/**
 * The `chat-model-port` pattern: one interface for a chat model, and one wire format behind it.
 *
 * The third pattern here that splits, and the seam is the one research §13 settled. The *core* is a port
 * — message and content types, a tool declaration, a request, a response, and the two interfaces a caller
 * depends on — and it names no provider. The *binding* is one wire format: encoding a request into it,
 * decoding an untrusted body out of it, and a factory that wires the two to `fetch`. Six providers want
 * one port and six bindings, and a caller's own code imports only the port (FR-017).
 *
 * Four decisions inside the emitted code are worth reading twice.
 *
 * **The system prompt is a field, not a role.** Every provider takes one; only some can take one in the
 * middle of a conversation. Making it `system?: string` on the request rather than a fourth message role
 * means the request that one wire format could not carry is not sayable, instead of being sayable and
 * failing at the boundary. That is the whole method of this pattern: the port is the *intersection*, and
 * where a provider offers more, `providerOptions` carries it through untyped and named.
 *
 * **A tool name is checked against the tools the request declared.** `toolChoice` is
 * `ToolChoice<ToolNamesOf<Tools>>`, so naming a tool that was not declared is a compile error, and
 * declaring none makes the named mode unusable — `ToolNamesOf<readonly []>` is `never`. That relies on
 * the tools' literal types surviving, which is what the `const` type parameter on `generate` is for: an
 * inline array of tool literals keeps its names without the caller writing `as const`.
 *
 * **A tool call's input is `unknown`.** A tool declares a JSON Schema, which is a *value*; there is no
 * type to be had from it without a schema library, and this bundle depends on nothing. Narrowing that
 * `unknown` is `parse-dont-validate`'s job, and recovering when it fails is `tool-loop`'s.
 *
 * **The stream is parts, not text.** `stream` yields a discriminated union — text deltas, a tool call
 * beginning, fragments of its JSON input, its end, and a finish — and folding those back into a
 * `ChatResponse` is `stream-accumulator`'s job. The adapter's work is the framing and the per-provider
 * event shapes, which is where the fiddly cases live: a `data:` field split across two chunks, an event
 * whose data spans several lines, a tool call identified by an index in one format and by an id in the
 * other.
 *
 * What could not be done is worth recording too. `ToolResultPart.failed` reaches one wire format and not
 * the other, because only one has a field for it; the port carries it and the adapter that cannot express
 * it says so. And the streaming half needs the response's byte stream, which the sandbox's platform
 * declarations did not have — so they grew three entries. The bundle still names its own structural
 * minimum for a byte stream rather than the platform's type, which is what lets one function accept a
 * body from Node, Deno, a browser, and a test's fake alike.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { dedent, doc, docAt, documented, joinLines, sections, when } from "../../render/helpers.js";
import { expectFileEntry, frameworkImports } from "../expect-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

interface Shape {
  /** `provider: "anthropic-messages"` — blocks and a hoisted system prompt, rather than chat messages. */
  readonly anthropic: boolean;
  /** `streaming: true` — the port declares `stream`, and the adapter decodes server-sent events. */
  readonly streaming: boolean;
  /**
   * `emitScope: "core-only"` — there is no adapter, so the example and the suite demonstrate the port
   * against a model of their own rather than against a wire format this scope did not emit.
   */
  readonly standalone: boolean;
}

interface Names {
  /** Provider-independent by definition: it is the file every adapter and every caller imports. */
  readonly coreStem: string;
  readonly bindingStem: string;
  readonly factory: string;
  readonly configType: string;
  /** How the emitted prose refers to the wire format. */
  readonly wireFormat: string;
  readonly exampleFn: string;
}

export const CORE_STEM = "chat-model-port";

export const chatModelPortPattern: PatternModule = {
  name: "chat-model-port",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      anthropic: options.provider === "anthropic-messages",
      streaming: options.streaming !== false,
      standalone: options.emitScope === "core-only",
    };
    const names = namesFor(shape);

    // Named after whichever half the file demonstrates, so a `core-only` caller's example is not named
    // after an adapter they were not sent.
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

/**
 * The output limit the Anthropic encoder falls back to, since that format requires the field.
 *
 * A constant here rather than a literal in the template so that the number in the emitted default, the
 * number in the emitted doc comment, and the number the emitted suite asserts on cannot drift apart.
 */
const DEFAULT_MAX_TOKENS = 4096;

function namesFor(shape: Shape): Names {
  if (shape.anthropic) {
    return {
      coreStem: CORE_STEM,
      bindingStem: "anthropic-chat-model",
      factory: "createAnthropicChatModel",
      configType: "AnthropicChatConfig",
      wireFormat: "Anthropic Messages",
      exampleFn: "askAnthropic",
    };
  }

  return {
    coreStem: CORE_STEM,
    bindingStem: "openai-chat-model",
    factory: "createOpenAiChatModel",
    configType: "OpenAiChatConfig",
    wireFormat: "OpenAI chat completions",
    exampleFn: "askOpenAi",
  };
}

// ---------------------------------------------------------------------------------------------------
// The core: the port, and everything an adapter needs that names no provider.
// ---------------------------------------------------------------------------------------------------

function core(shape: Shape): string {
  return sections(
    coreHeader(shape),
    schemaType(),
    contentTypes(),
    messageTypes(),
    toolTypes(),
    requestType(),
    responseTypes(),
    when(shape.streaming, streamPartType()),
    modelTypes(shape),
    errorTypes(),
    messageHelpers(),
    contentHelpers(),
    bodyReaders(),
    when(shape.streaming, sseSection()),
    when(shape.streaming, byteSection()),
  );
}

function coreHeader(shape: Shape): string {
  return doc(
    "A provider-agnostic port for a chat model.",
    "Nothing here names a provider, and nothing here imports one. A caller's own code depends on `ChatModel` and on the message types; one adapter per wire format sits between that and a service, and swapping providers is a change to the line that constructs a model.",
    "The port is deliberately an *intersection* rather than a union of what providers offer. A field is here only if every mainstream wire format can carry it, which is why the system prompt is a field rather than a message role, why a user message is text, and why `providerOptions` exists: what is particular to one service goes through by name, untyped, and visibly.",
    when(
      shape.streaming,
      "Two things live here that look like transport rather than port: the server-sent-event framing and the byte-stream bridge. They are here because every adapter needs both and neither mentions a provider — a second adapter would otherwise copy them, and the copy is where they would drift.",
    ),
  );
}

function schemaType(): string {
  return documented(
    [
      "A tool's input schema, as JSON Schema.",
      "`Readonly<Record<string, unknown>>` and no more. Typing JSON Schema properly is a project of its own, every provider accepts a slightly different dialect of it, and the value here is passed through to the wire rather than interpreted — so a stricter type would buy nothing and refuse valid schemas.",
    ],
    "export type JsonSchema = Readonly<Record<string, unknown>>;",
  );
}

function contentTypes(): string {
  return sections(
    doc("The parts a message is made of."),
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
      [
        "The model asking for a tool to be run.",
        "`input` is `unknown` because a tool declares a JSON *Schema*, which is a value: there is no type to derive from it without a schema library, and this file depends on nothing. Narrow it where it is used, and treat a failure to narrow as the model's mistake rather than yours — it is a common one.",
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
        "What running a tool produced, on its way back to the model.",
        "`callId` has to match the call it answers: that, and not the order they are sent in, is what pairs a result with a request.",
        "`failed` is advisory. One wire format carries a flag for it; the other has no field to put it in, and its adapter says so where it drops it. Either way the model is told what happened by the `output` — an error is more useful as a sentence the model can read than as a boolean it cannot.",
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
      [
        "What an assistant turn can contain, and what a response contains.",
        "One type in both places on purpose: a response can be appended to the conversation as an assistant message with no reshaping, which is the step a tool loop takes on every iteration and the step that is easy to get wrong.",
      ],
      "export type AssistantContent = readonly (TextPart | ToolCallPart)[];",
    ),
  );
}

function messageTypes(): string {
  return sections(
    doc(
      "The conversation, as three roles.",
      "There is no `system` role. A system prompt is a field on the request instead, for a reason worth stating: one wire format takes it as the first message and another as a field of its own, and only the first can express a system prompt that arrives in the middle of a conversation. Making it a field means the request no provider could carry is not one this port can describe.",
    ),
    documented(
      [
        "What the caller said.",
        "Text parts only. Images and audio are where wire formats diverge most — a data URL here, a base64 field with a media type there, a file handle uploaded in advance somewhere else — and a port that guessed would be wrong for two providers out of three. Adding a part type later is additive; getting one wrong now is not.",
      ],
      dedent`
        export interface UserMessage {
          readonly role: "user";
          readonly content: readonly TextPart[];
        }
      `,
    ),
    documented(
      ["What the model said, which is the only role that can ask for a tool to be run."],
      dedent`
        export interface AssistantMessage {
          readonly role: "assistant";
          readonly content: AssistantContent;
        }
      `,
    ),
    documented(
      [
        "What the tools produced, which is the only role that can carry a result.",
        "A separate role rather than a kind of user message, even though one wire format encodes it as exactly that. The distinction is real — these are not the caller speaking — and an adapter that has to collapse it can, while one handed a collapsed list could not tell the two apart again.",
      ],
      dedent`
        export interface ToolMessage {
          readonly role: "tool";
          readonly content: readonly ToolResultPart[];
        }
      `,
    ),
    "export type Message = UserMessage | AssistantMessage | ToolMessage;",
  );
}

function toolTypes(): string {
  return sections(
    documented(
      [
        "A tool the model may ask to have run.",
        "`name` is what comes back in a `ToolCallPart`, so it is worth keeping short and stable — it appears in the model's context on every turn.",
      ],
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
      "export type ToolNamesOf<Tools extends readonly ToolDefinition[]> = Tools[number][\"name\"];",
    ),
    documented(
      [
        "Whether the model may use a tool, must use one, or must use a particular one.",
        "`Names` is filled in from the request's own tools, so `{ mode: \"tool\", toolName: \"lookup\" }` is only accepted where `lookup` was declared. A separate mode for each case rather than `toolName?: string` alongside a boolean: three of the four carry nothing, and an optional name beside a mode that does not use it is a field two states can disagree about.",
      ],
      dedent`
        export type ToolChoice<Names extends string> =
          | { readonly mode: "auto" }
          | { readonly mode: "none" }
          | { readonly mode: "required" }
          | { readonly mode: "tool"; readonly toolName: Names };
      `,
    ),
  );
}

function requestType(): string {
  return documented(
    [
      "One turn's worth of input.",
      "`Tools` defaults to the empty tuple rather than to `readonly ToolDefinition[]`, which is what makes `toolChoice: { mode: \"tool\", … }` unusable on a request that declared no tools. Left as the wider default, `ToolNamesOf<Tools>` would widen to `string` and accept any name at all.",
      "`providerOptions` is the escape hatch, and it is here rather than absent because a port without one gets abandoned the first time somebody needs a field it does not have. Its contents are merged into the request body as they are, so what goes in it is a wire-format detail — visible at the call site, and the one place to look when a request behaves differently on one provider.",
    ],
    dedent`
      export interface ChatRequest<Tools extends readonly ToolDefinition[] = readonly []> {
        readonly messages: readonly Message[];
        /** The system prompt. A field rather than a message, for the reason given above the roles. */
        readonly system?: string;
        readonly tools?: Tools;
        readonly toolChoice?: ToolChoice<ToolNamesOf<Tools>>;
        readonly maxOutputTokens?: number;
        readonly temperature?: number;
        readonly stopSequences?: readonly string[];
        readonly signal?: AbortSignal;
        /** Merged into the request body verbatim. Whatever this port does not describe goes here. */
        readonly providerOptions?: Readonly<Record<string, unknown>>;
      }
    `,
  );
}

function responseTypes(): string {
  return sections(
    documented(
      [
        "Why the model stopped.",
        "Five cases, because that is what the wire formats agree on once their names are mapped. `\"other\"` is not a failure — it is an honest answer for a value this port has no case for, and the adapter records the original in `warnings` rather than throwing away a usable response over a string it did not recognise.",
      ],
      'export type FinishReason = "stop" | "length" | "tool-calls" | "filtered" | "other";',
    ),
    documented(
      [
        "Tokens in and out, where the provider reported them.",
        "Both fields are present and possibly `undefined` rather than optional, so that reading one is a check for `undefined` rather than a check for a missing property — and so that a provider reporting neither still produces a `usage` object rather than nothing.",
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
        "One turn's worth of output.",
        "`raw` is the counterpart to `providerOptions`: whatever the response carried that this port does not describe is still reachable, so a caller who needs one field of it does not have to abandon the port to get it.",
      ],
      dedent`
        export interface ChatResponse {
          readonly content: AssistantContent;
          readonly finishReason: FinishReason;
          readonly usage: Usage;
          /** What the provider said it used, which is not always what was asked for. */
          readonly modelId: string;
          /** Anything the adapter had to decide rather than read. Empty is the normal case. */
          readonly warnings: readonly string[];
          readonly raw: unknown;
        }
      `,
    ),
  );
}

function streamPartType(): string {
  return documented(
    [
      "What a streamed turn arrives as.",
      "Parts rather than text, because a stream that yielded only strings could not report a tool call at all — and tool input arrives as fragments of JSON that are not parseable until the last one. So the fragments are passed through as text and assembling them is a separate job, which is what `stream-accumulator` is for.",
      "`tool-call-end` is guaranteed for every call that started, including where the wire format has no event for it and the adapter has to work out that one ended.",
    ],
    dedent`
      export type StreamPart =
        | { readonly type: "text-delta"; readonly text: string }
        | { readonly type: "tool-call-start"; readonly callId: string; readonly toolName: string }
        | { readonly type: "tool-input-delta"; readonly callId: string; readonly delta: string }
        | { readonly type: "tool-call-end"; readonly callId: string }
        | {
            readonly type: "finish";
            readonly finishReason: FinishReason;
            readonly usage: Usage;
            readonly warnings: readonly string[];
          };
    `,
  );
}

function modelTypes(shape: Shape): string {
  const streaming = when(
    shape.streaming,
    sections(
      documented(
        [
          "A model that can also stream.",
          "A second interface rather than an optional method, so that code needing a stream says so in its parameter type instead of checking at run time for a method that may not be there.",
          "`stream` returns an `AsyncIterable` rather than a `Promise` of one, which is what lets a caller write `for await` on the result directly. The request is not sent until the first value is asked for.",
        ],
        dedent`
          export interface StreamingChatModel extends ChatModel {
            stream<const Tools extends readonly ToolDefinition[] = readonly []>(
              request: ChatRequest<Tools>,
            ): AsyncIterable<StreamPart>;
          }
        `,
      ),
    ),
  );

  return sections(
    documented(
      [
        "The port.",
        "`const Tools` is what keeps an array of tool literals *written at the call site* from widening: without it, `tools: [{ name: \"lookup\", … }]` infers `name: string`, `ToolNamesOf` collapses to `string`, and `toolChoice` accepts a name no tool has. With it, ordinary code is checked — no `as const`, and no `satisfies`.",
        "It does not reach a tools array hoisted into a variable, and it cannot: that one widens where it is *declared*, and nothing at the call site can narrow it back. A shared list of tools therefore wants `as const satisfies readonly ToolDefinition[]` on its own declaration, which is what the example beside this file does and why.",
        "One method, and it takes everything. A model with a dozen configuration methods is a model whose state a caller has to reason about; a request that carries its own is one a caller can build, log, and replay.",
      ],
      dedent`
        export interface ChatModel {
          /** What this model was constructed for. The response reports what actually answered. */
          readonly modelId: string;
          generate<const Tools extends readonly ToolDefinition[] = readonly []>(
            request: ChatRequest<Tools>,
          ): Promise<ChatResponse>;
        }
      `,
    ),
    streaming,
  );
}

function errorTypes(): string {
  return sections(
    documented(
      [
        "A failure reaching the model, or a failure the model reported.",
        "`retryable` is the field that matters, and the adapter is the only thing in a position to set it: it is the only code that saw the status and the provider's own error shape. A caller wraps `generate` in a retry that reads this rather than guessing from a message.",
      ],
      dedent`
        export class ChatModelError extends Error {
          readonly retryable: boolean;
          readonly status: number | undefined;

          constructor(
            message: string,
            options: {
              readonly retryable: boolean;
              readonly status?: number;
              readonly cause?: unknown;
            },
          ) {
            super(message, options.cause === undefined ? undefined : { cause: options.cause });
            this.name = "ChatModelError";
            this.retryable = options.retryable;
            this.status = options.status;
          }
        }
      `,
    ),
    documented(
      [
        "The provider answered, but not in the shape it documents.",
        "Never retryable: sending the same request again to get the same malformed answer is a way of turning one bug into a rate limit. The body is kept, because the only useful thing to do with this is look at it.",
      ],
      dedent`
        export class MalformedResponseError extends ChatModelError {
          readonly body: unknown;

          constructor(message: string, body: unknown) {
            super(message, { retryable: false });
            this.name = "MalformedResponseError";
            this.body = body;
          }
        }
      `,
    ),
  );
}

function messageHelpers(): string {
  return sections(
    doc(
      "Constructors for the shapes a caller writes most often.",
      "Small enough to inline and worth having anyway: the literal spelling of a user message is four levels of nesting for one string, and that is the sort of noise that makes people reach for a provider SDK.",
    ),
    dedent`
      export function userMessage(text: string): UserMessage {
        return { role: "user", content: [{ type: "text", text }] };
      }
    `,
    documented(
      [
        "A response, as the assistant message that goes back into the conversation.",
        "The step every multi-turn loop takes, and the one that has to be exact: dropping the tool calls here is how a loop ends up sending results for calls the conversation has no record of, which every provider rejects.",
      ],
      dedent`
        export function assistantMessageOf(response: ChatResponse): AssistantMessage {
          return { role: "assistant", content: response.content };
        }
      `,
    ),
    dedent`
      export function toolMessage(results: readonly ToolResultPart[]): ToolMessage {
        return { role: "tool", content: results };
      }
    `,
  );
}

function contentHelpers(): string {
  return sections(
    documented(
      [
        "Every text part, concatenated.",
        "Concatenated rather than joined with a separator: the parts of one turn are a single run of prose that arrived in pieces, and anything put between them appears in the middle of a sentence.",
      ],
      dedent`
        export function textOf(content: AssistantContent): string {
          return content
            .filter((part): part is TextPart => part.type === "text")
            .map((part) => part.text)
            .join("");
        }
      `,
    ),
    dedent`
      export function toolCallsOf(content: AssistantContent): readonly ToolCallPart[] {
        return content.filter((part): part is ToolCallPart => part.type === "tool-call");
      }
    `,
  );
}

function bodyReaders(): string {
  return sections(
    doc(
      "Reading an untrusted body.",
      "Here rather than in the adapter because every adapter needs the same five functions, and a copy per wire format is five chances for one of them to be subtly laxer than the others. They are exported for that reason and not as part of the port's surface.",
      "Each one answers with `undefined` rather than throwing, so a decoder reads a body field by field and decides for itself which absences are fatal. The alternative — a reader that throws — puts that decision in the wrong place, and makes an optional field indistinguishable from a malformed one.",
    ),
    dedent`
      export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
      }
    `,
    documented(
      [
        "`readonly unknown[]`, not `any[]`.",
        "`Array.isArray` narrows an `unknown` to `any[]`, and every element read from it afterwards is an `any` that no longer has to be checked at all. That is the one boundary this whole file exists to police, so it is worth one function to keep it.",
      ],
      dedent`
        export function isArray(value: unknown): value is readonly unknown[] {
          return Array.isArray(value);
        }
      `,
    ),
    dedent`
      export function stringAt(
        source: Readonly<Record<string, unknown>>,
        name: string,
      ): string | undefined {
        const value = source[name];
        return typeof value === "string" ? value : undefined;
      }

      export function numberAt(
        source: Readonly<Record<string, unknown>>,
        name: string,
      ): number | undefined {
        const value = source[name];
        return typeof value === "number" ? value : undefined;
      }

      export function recordAt(
        source: Readonly<Record<string, unknown>>,
        name: string,
      ): Readonly<Record<string, unknown>> | undefined {
        const value = source[name];
        return isRecord(value) ? value : undefined;
      }
    `,
  );
}

function sseSection(): string {
  return sections(
    doc(
      "Server-sent events, framed out of a stream of text chunks.",
      "Framing is the part of streaming that is easy to get almost right. A chunk is whatever the network handed over: it can end in the middle of a `data:` line, carry three events at once, or split a two-byte character in half — which is why the bridge below decodes bytes incrementally rather than one chunk at a time.",
      "The full field syntax is honoured rather than the shorthand every provider happens to use, because the cost is a dozen lines and the failure mode of assuming one `data:` line per event is a truncated payload that parses as JSON.",
    ),
    dedent`
      export interface SseEvent {
        /** The \`event:\` field, where the stream sent one. One wire format needs it; the other does not. */
        readonly event: string | undefined;
        /** Every \`data:\` line of one event, joined with newlines, as the specification requires. */
        readonly data: string;
      }
    `,
    dedent`
      export async function* sseEvents(chunks: AsyncIterable<string>): AsyncIterable<SseEvent> {
        let buffer = "";
        let event: string | undefined;
        let data: string[] = [];

        const framed = (): SseEvent | undefined => {
          if (data.length === 0) {
            // A blank line after no data lines dispatches nothing. Comments and keep-alives arrive that
            // way, and a stream that yielded an empty event for each of them would be unusable.
            event = undefined;
            return undefined;
          }
          const dispatched: SseEvent = { event, data: data.join("\\n") };
          event = undefined;
          data = [];
          return dispatched;
        };

        for await (const chunk of chunks) {
          buffer += chunk;

          for (;;) {
            const breakAt = buffer.indexOf("\\n");
            if (breakAt === -1) {
              break;
            }
            const line = withoutCarriageReturn(buffer.slice(0, breakAt));
            buffer = buffer.slice(breakAt + 1);

            if (line === "") {
              const dispatched = framed();
              if (dispatched !== undefined) {
                yield dispatched;
              }
              continue;
            }
            // A comment line starts with the colon, which names the empty field and falls through
            // the dispatch below with every other field this reader has no use for. That is what
            // the specification asks for, and it is why there is no case for it here.
            const colonAt = line.indexOf(":");
            const field = colonAt === -1 ? line : line.slice(0, colonAt);
            const raw = colonAt === -1 ? "" : line.slice(colonAt + 1);
            // One leading space belongs to the syntax, not to the value. Two do not.
            const value = raw.startsWith(" ") ? raw.slice(1) : raw;

            if (field === "data") {
              data.push(value);
            } else if (field === "event") {
              event = value;
            }
          }
        }

        // A stream that ended without a blank line still sent its last event. Every provider does this.
        const last = withoutCarriageReturn(buffer);
        if (last.startsWith("data:")) {
          const raw = last.slice("data:".length);
          data.push(raw.startsWith(" ") ? raw.slice(1) : raw);
        }
        const dispatched = framed();
        if (dispatched !== undefined) {
          yield dispatched;
        }
      }

      function withoutCarriageReturn(line: string): string {
        return line.endsWith("\\r") ? line.slice(0, -1) : line;
      }
    `,
  );
}

function byteSection(): string {
  return sections(
    doc(
      "The bridge from a response body to text chunks.",
      "The types here are this file's own rather than the platform's, and that is the point: a `ReadableStream` from Node, from a browser, from Deno, and a fake from a test are all this shape, so one function takes all four and the bundle names no host type it would have to be right about.",
    ),
    dedent`
      export interface ByteStreamReader {
        read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
        releaseLock(): void;
      }

      export interface ByteStream {
        getReader(): ByteStreamReader;
      }
    `,
    documented(
      [
        "Bytes to text, decoded incrementally.",
        "`{ stream: true }` is what makes a multi-byte character split across two chunks come out whole; decoding each chunk on its own produces a replacement character at every such boundary, which is a bug that only shows up in the languages nobody tested in. The final `decode()` with no argument flushes whatever was left half-read.",
      ],
      dedent`
        export async function* textChunks(stream: ByteStream): AsyncIterable<string> {
          const decoder = new TextDecoder();
          const reader = stream.getReader();

          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (value !== undefined) {
                const text = decoder.decode(value, { stream: true });
                if (text !== "") {
                  yield text;
                }
              }
              if (done) {
                break;
              }
            }
            const tail = decoder.decode();
            if (tail !== "") {
              yield tail;
            }
          } finally {
            reader.releaseLock();
          }
        }
      `,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The binding: one wire format, and the transport that carries it.
// ---------------------------------------------------------------------------------------------------

function binding(context: RenderContext, names: Names, shape: Shape): string {
  const coreSpec = siblingSpecifier(context.conventions, names.coreStem);

  return sections(
    bindingHeader(names, shape),
    importsFrom(context.conventions, coreSpec, {
      values: [
        "ChatModelError",
        "MalformedResponseError",
        "isArray",
        "isRecord",
        "numberAt",
        "recordAt",
        "stringAt",
        ...(shape.anthropic ? [] : ["textOf", "toolCallsOf"]),
        ...(shape.streaming ? ["sseEvents", "textChunks"] : []),
      ],
      types: [
        "AssistantContent",
        ...(shape.streaming ? ["ByteStream"] : []),
        "ChatRequest",
        "ChatResponse",
        "FinishReason",
        "Message",
        ...(shape.streaming ? ["StreamPart", "StreamingChatModel"] : ["ChatModel"]),
        ...(shape.anthropic ? [] : ["ToolCallPart"]),
        "ToolChoice",
        "ToolDefinition",
        "Usage",
      ],
    }),
    transportTypes(shape),
    configType(names, shape),
    encodeSection(shape),
    decodeSection(shape),
    when(shape.streaming, streamSection(shape)),
    factorySection(names, shape),
  );
}

function bindingHeader(names: Names, shape: Shape): string {
  return doc(
    `The ${names.wireFormat} adapter for the port.`,
    "Three exported pieces and one of them does the interesting work. `encodeRequest` and `decodeResponse` are pure functions over plain data, which is what makes this file testable against a recorded body and no network at all — and the factory is a thin wiring of those two to `fetch`.",
    shape.anthropic
      ? "What this format wants and the port does not have: a system prompt as a top-level field, a required output limit, tool results as blocks inside a *user* message, and one message per alternating turn. Each of those is absorbed here, and each one is marked where it happens."
      : "What this format wants and the port does not have: a system prompt as the first message, one message per tool result rather than one per turn, and tool arguments as a JSON *string* rather than a value. Each of those is absorbed here, and each one is marked where it happens.",
    when(
      shape.streaming,
      shape.anthropic
        ? "The stream is a sequence of named events over indexed content blocks, so a tool call's identity arrives once, at its start, and every fragment afterwards refers to it by index. Keeping that index-to-call map is most of what the stream decoder does."
        : "The stream carries no `event:` field, so the payload's own shape is the discriminant, and it ends with a `[DONE]` sentinel that is not JSON. A tool call is identified by its position in an array rather than by an event of its own, so a call's end has to be worked out rather than read.",
    ),
  );
}

function transportTypes(shape: Shape): string {
  const body = when(
    shape.streaming,
    "\n  /** The response body as a byte stream, which is `null` when there is no body to read. */\n  readonly body: ByteStream | null;",
  );

  return sections(
    documented(
      [
        "The transport, as the least this adapter needs of it.",
        "Structural, and declared here rather than taken from the platform, for two reasons. A real `fetch` satisfies it — so the default costs a caller nothing — and a test satisfies it with six lines and no network, which is the only way the decoding below can be checked against the bodies that actually cause trouble.",
      ],
      dedent`
        export type FetchLike = (
          url: string,
          init: {
            readonly method: string;
            readonly headers: Readonly<Record<string, string>>;
            readonly body: string;
            readonly signal?: AbortSignal;
          },
        ) => Promise<FetchResponse>;

        export interface FetchResponse {
          readonly ok: boolean;
          readonly status: number;
          json(): Promise<unknown>;
          text(): Promise<string>;${body}
        }
      `,
    ),
  );
}

function configType(names: Names, shape: Shape): string {
  const maxTokens = when(
    shape.anthropic,
    joinLines(
      docAt(
        2,
        "The output limit to send when a request does not give one.",
        `This format requires the field, so something has to supply it. ${DEFAULT_MAX_TOKENS} is a value, not a recommendation: it is small enough to bound a runaway response and large enough for most answers, and it is here rather than buried in the encoder so that raising it is a line of configuration.`,
      ),
      "  readonly maxOutputTokens?: number;",
    ),
  );

  return documented(
    [`What \`${names.factory}\` needs.`],
    joinLines(
      `export interface ${names.configType} {`,
      "  readonly modelId: string;",
      "  readonly apiKey: string;",
      "  /** Where to send it. Override for a gateway, a proxy, or a compatible service. */",
      "  readonly baseUrl?: string;",
      "  /** Merged over the ones this adapter sets, so a caller can add a header or replace one. */",
      "  readonly headers?: Readonly<Record<string, string>>;",
      maxTokens,
      "  /** Defaults to the platform's `fetch`. Supply one to record, replay, or instrument. */",
      "  readonly fetch?: FetchLike;",
      "}",
    ),
  );
}

function encodeSection(shape: Shape): string {
  return shape.anthropic ? anthropicEncode() : openAiEncode();
}

function openAiEncode(): string {
  return sections(
    doc("Encoding: the port's request, as this format's body."),
    documented(
      [
        "One wire message per turn, except for tool results.",
        "This format keys a result to the call it answers rather than grouping results by turn, so one `ToolMessage` carrying three results becomes three wire messages. Grouping them into one would leave two calls unanswered, which this API rejects with a message about the ones it did not find.",
        "An assistant turn with tool calls and no text sends `content: null` rather than an empty string: the empty string is content, and a model handed it on the next turn treats it as something it said.",
      ],
      dedent`
        export function encodeMessages(
          system: string | undefined,
          messages: readonly Message[],
        ): readonly Readonly<Record<string, unknown>>[] {
          const wire: Readonly<Record<string, unknown>>[] = [];

          // The system prompt is this format's first message. The port keeps it out of the list so that
          // the other format, which has nowhere in the list to put it, is describable by the same type.
          if (system !== undefined) {
            wire.push({ role: "system", content: system });
          }

          for (const message of messages) {
            if (message.role === "user") {
              wire.push({
                role: "user",
                content: message.content.map((part) => part.text).join(""),
              });
              continue;
            }

            if (message.role === "tool") {
              for (const result of message.content) {
                // \`failed\` is dropped here, and this is the format that has no field for it. The model
                // learns what happened from the output, which is where a description of the failure
                // belongs anyway.
                wire.push({
                  role: "tool",
                  tool_call_id: result.callId,
                  content: textOfOutput(result.output),
                });
              }
              continue;
            }

            const text = textOf(message.content);
            const calls = toolCallsOf(message.content);

            wire.push({
              role: "assistant",
              content: text === "" ? null : text,
              ...(calls.length === 0
                ? {}
                : {
                    tool_calls: calls.map((call) => ({
                      id: call.callId,
                      type: "function",
                      // Arguments go out as a JSON *string*, which is what this format asks for and
                      // what makes a round trip through it lossy for anything JSON cannot hold.
                      function: { name: call.toolName, arguments: JSON.stringify(call.input) },
                    })),
                  }),
            });
          }

          return wire;
        }
      `,
    ),
    outputTextHelper(),
    documented(
      [
        "The whole body.",
        "`providerOptions` is merged last, so a caller can override any field this function sets. That is deliberate: the alternative is a caller who needs one unusual field having to abandon the adapter entirely.",
      ],
      dedent`
        export function encodeRequest<Tools extends readonly ToolDefinition[]>(
          modelId: string,
          request: ChatRequest<Tools>,
          streaming: boolean,
        ): Readonly<Record<string, unknown>> {
          const tools = request.tools ?? [];

          return {
            model: modelId,
            messages: encodeMessages(request.system, request.messages),
            ...(tools.length === 0
              ? {}
              : {
                  tools: tools.map((tool) => ({
                    type: "function",
                    function: {
                      name: tool.name,
                      ...(tool.description === undefined ? {} : { description: tool.description }),
                      parameters: tool.inputSchema,
                    },
                  })),
                }),
            ...(request.toolChoice === undefined
              ? {}
              : { tool_choice: encodeToolChoice(request.toolChoice) }),
            ...(request.maxOutputTokens === undefined
              ? {}
              : { max_completion_tokens: request.maxOutputTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
            // \`include_usage\` because a streamed response reports none without it, and a caller
            // counting tokens should not have to know that this is where it is asked for.
            ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
            ...(request.providerOptions ?? {}),
          };
        }
      `,
    ),
    dedent`
      function encodeToolChoice(choice: ToolChoice<string>): unknown {
        switch (choice.mode) {
          case "tool":
            return { type: "function", function: { name: choice.toolName } };
          case "required":
            return "required";
          case "none":
            return "none";
          case "auto":
            return "auto";
        }
      }
    `,
  );
}

function anthropicEncode(): string {
  return sections(
    doc("Encoding: the port's request, as this format's body."),
    documented(
      [
        "The conversation, as alternating turns of content blocks.",
        "Two things happen here that the port's list does not describe. Tool results become blocks in a *user* message, because this format has no separate role for them — the distinction the port keeps is real, and collapsing it is this adapter's job rather than the caller's. And consecutive messages of the same role are merged into one turn, since a tool result followed by more text from the caller is two messages in the port and one turn here.",
      ],
      dedent`
        export function encodeMessages(
          messages: readonly Message[],
        ): readonly Readonly<Record<string, unknown>>[] {
          const wire: { readonly role: string; readonly content: unknown[] }[] = [];

          const push = (role: string, blocks: readonly unknown[]): void => {
            const last = wire.at(-1);
            if (last !== undefined && last.role === role) {
              last.content.push(...blocks);
              return;
            }
            wire.push({ role, content: [...blocks] });
          };

          for (const message of messages) {
            if (message.role === "user") {
              push(
                "user",
                message.content.map((part) => ({ type: "text", text: part.text })),
              );
              continue;
            }

            if (message.role === "tool") {
              push(
                "user",
                message.content.map((result) => ({
                  type: "tool_result",
                  tool_use_id: result.callId,
                  content: textOfOutput(result.output),
                  // The one wire format with a field for this. The other drops it.
                  ...(result.failed === true ? { is_error: true } : {}),
                })),
              );
              continue;
            }

            push(
              "assistant",
              message.content.map((part) =>
                part.type === "text"
                  ? { type: "text", text: part.text }
                  : // Input goes out as a value rather than as a JSON string, which is this
                    // format's shape and the reason a decoder for it needs no parse step.
                    { type: "tool_use", id: part.callId, name: part.toolName, input: part.input },
              ),
            );
          }

          return wire;
        }
      `,
    ),
    outputTextHelper(),
    documented(
      [
        "The whole body.",
        "`max_tokens` is required by this format, so a request that names no limit gets the configured one. `providerOptions` is merged last, so a caller can override any field this function sets — including that limit.",
      ],
      dedent`
        export function encodeRequest<Tools extends readonly ToolDefinition[]>(
          config: { readonly modelId: string; readonly maxOutputTokens?: number },
          request: ChatRequest<Tools>,
          streaming: boolean,
        ): Readonly<Record<string, unknown>> {
          const tools = request.tools ?? [];

          return {
            model: config.modelId,
            max_tokens: request.maxOutputTokens ?? config.maxOutputTokens ?? ${String(DEFAULT_MAX_TOKENS)},
            messages: encodeMessages(request.messages),
            // A field rather than a message, which is the whole reason the port keeps it out of the list.
            ...(request.system === undefined ? {} : { system: request.system }),
            ...(tools.length === 0
              ? {}
              : {
                  tools: tools.map((tool) => ({
                    name: tool.name,
                    ...(tool.description === undefined ? {} : { description: tool.description }),
                    input_schema: tool.inputSchema,
                  })),
                }),
            ...(request.toolChoice === undefined
              ? {}
              : { tool_choice: encodeToolChoice(request.toolChoice) }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.stopSequences === undefined
              ? {}
              : { stop_sequences: request.stopSequences }),
            ...(streaming ? { stream: true } : {}),
            ...(request.providerOptions ?? {}),
          };
        }
      `,
    ),
    documented(
      [
        "`required` is spelled `any` here, which is the sort of difference a port exists to absorb.",
      ],
      dedent`
        function encodeToolChoice(choice: ToolChoice<string>): unknown {
          switch (choice.mode) {
            case "tool":
              return { type: "tool", name: choice.toolName };
            case "required":
              return { type: "any" };
            case "none":
              return { type: "none" };
            case "auto":
              return { type: "auto" };
          }
        }
      `,
    ),
  );
}

function outputTextHelper(): string {
  return documented(
    [
      "A tool's output, as the text this format carries.",
      "A string goes through untouched. Anything else is serialised, because a result that arrived as an object has to reach the model as *something*, and JSON is the form it was asked to produce input in.",
    ],
    dedent`
      function textOfOutput(output: unknown): string {
        return typeof output === "string" ? output : JSON.stringify(output);
      }
    `,
  );
}

function decodeSection(shape: Shape): string {
  return sections(
    doc(
      "Decoding: an untrusted body, as the port's response.",
      "Every field is read rather than assumed, and not out of defensiveness for its own sake: a body that lost a field to a gateway, a proxy that answered 200 with an HTML error page, and a compatible service that implements nine tenths of this format are all things that happen, and each produces a clearer failure here than three frames later where the value is used.",
    ),
    finishReasonSection(shape),
    shape.anthropic ? anthropicDecode() : openAiDecode(),
  );
}

function finishReasonSection(shape: Shape): string {
  const table = shape.anthropic
    ? dedent`
        const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
          end_turn: "stop",
          stop_sequence: "stop",
          max_tokens: "length",
          tool_use: "tool-calls",
          refusal: "filtered",
        };
      `
    : dedent`
        const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
          stop: "stop",
          length: "length",
          tool_calls: "tool-calls",
          function_call: "tool-calls",
          content_filter: "filtered",
        };
      `;

  return sections(
    documented(
      [
        "This format's names for why the model stopped, as the port's.",
        "A table rather than a `switch`, so the mapping is a value one can read at a glance and compare against the other adapter's.",
      ],
      table,
    ),
    documented(
      [
        'An unrecognised reason is a warning and `"other"`, not a failure.',
        "Providers add these. Refusing a response that is otherwise perfectly usable because it stopped for a reason released last week would be the wrong trade every time, and the original string is kept where a caller can see it.",
      ],
      dedent`
        function decodeFinishReason(raw: string | undefined, warnings: string[]): FinishReason {
          if (raw === undefined || raw === "") {
            return "other";
          }
          const mapped = FINISH_REASONS[raw];
          if (mapped === undefined) {
            warnings.push(\`unrecognised stop reason \${JSON.stringify(raw)}\`);
            return "other";
          }
          return mapped;
        }
      `,
    ),
  );
}

function openAiDecode(): string {
  return sections(
    dedent`
      function decodeUsage(body: Readonly<Record<string, unknown>>): Usage {
        const usage = recordAt(body, "usage");
        return {
          inputTokens: usage === undefined ? undefined : numberAt(usage, "prompt_tokens"),
          outputTokens: usage === undefined ? undefined : numberAt(usage, "completion_tokens"),
        };
      }
    `,
    documented(
      [
        "One choice's worth of a body, as a response.",
        "The first choice and no other. Asking for several is possible in this format and is not something the port describes, because the other format cannot do it — a caller who needs them has `raw`.",
      ],
      dedent`
        export function decodeResponse(body: unknown, modelId: string): ChatResponse {
          if (!isRecord(body)) {
            throw new MalformedResponseError("the response body was not an object", body);
          }

          const choices = body["choices"];
          if (!isArray(choices) || choices.length === 0) {
            throw new MalformedResponseError("the response carried no choices", body);
          }
          const choice = choices[0];
          if (!isRecord(choice)) {
            throw new MalformedResponseError("the first choice was not an object", body);
          }
          const message = recordAt(choice, "message");
          if (message === undefined) {
            throw new MalformedResponseError("the first choice carried no message", body);
          }

          const warnings: string[] = [];
          const content: AssistantContent = [
            ...textPartsOf(message),
            ...toolCallPartsOf(message, body),
          ];

          return {
            content,
            finishReason: decodeFinishReason(stringAt(choice, "finish_reason"), warnings),
            usage: decodeUsage(body),
            // What answered, falling back to what was asked for: a gateway that rewrites the model
            // reports the one it used, and that is the more useful of the two to hand back.
            modelId: stringAt(body, "model") ?? modelId,
            warnings,
            raw: body,
          };
        }
      `,
    ),
    documented(
      [
        "Text, if there is any.",
        'An empty string is dropped rather than kept as a part. This format sends `content: null` alongside tool calls and some services send `""` instead, and a response whose only content was an empty text part would make `textOf` and a check on `length` disagree about whether the model said anything.',
      ],
      dedent`
        function textPartsOf(message: Readonly<Record<string, unknown>>): AssistantContent {
          const text = stringAt(message, "content");
          return text === undefined || text === "" ? [] : [{ type: "text", text }];
        }
      `,
    ),
    dedent`
      function toolCallPartsOf(
        message: Readonly<Record<string, unknown>>,
        body: unknown,
      ): readonly ToolCallPart[] {
        const calls = message["tool_calls"];
        return isArray(calls) ? calls.map((raw) => decodeToolCall(raw, body)) : [];
      }
    `,
    documented(
      [
        "@throws MalformedResponseError when a call has no id, no name, or arguments that are not JSON.",
        "Unparseable arguments are a protocol violation rather than a model mistake — this format promises a JSON string — so they fail here. A model that produced *valid* JSON of the wrong shape is the common case and is not this function's problem: that is a schema question, and answering it by sending the model its own error is what a tool loop does.",
      ],
      dedent`
        function decodeToolCall(raw: unknown, body: unknown): ToolCallPart {
          if (!isRecord(raw)) {
            throw new MalformedResponseError("a tool call was not an object", body);
          }
          const invoked = recordAt(raw, "function");
          const callId = stringAt(raw, "id");
          const toolName = invoked === undefined ? undefined : stringAt(invoked, "name");
          if (callId === undefined || toolName === undefined) {
            throw new MalformedResponseError("a tool call carried no id or no name", body);
          }
          const args = invoked === undefined ? undefined : stringAt(invoked, "arguments");

          return { type: "tool-call", callId, toolName, input: decodeArguments(args, body) };
        }
      `,
    ),
    documented(
      [
        "An absent or empty argument string is an empty object.",
        'A tool with no parameters is called with `""` by some services and `"{}"` by others, and a caller should not have to know which one they are talking to.',
      ],
      dedent`
        function decodeArguments(args: string | undefined, body: unknown): unknown {
          if (args === undefined || args === "") {
            return {};
          }
          try {
            return JSON.parse(args) as unknown;
          } catch (cause) {
            throw new MalformedResponseError(
              \`a tool call's arguments were not JSON: \${String(cause)}\`,
              body,
            );
          }
        }
      `,
    ),
  );
}

function anthropicDecode(): string {
  return sections(
    dedent`
      function decodeUsage(body: Readonly<Record<string, unknown>>): Usage {
        const usage = recordAt(body, "usage");
        return {
          inputTokens: usage === undefined ? undefined : numberAt(usage, "input_tokens"),
          outputTokens: usage === undefined ? undefined : numberAt(usage, "output_tokens"),
        };
      }
    `,
    documented(
      [
        "A body, as a response.",
        "The content is already a list of blocks in this format, which maps onto the port's parts almost exactly — the one difference being that a tool call's input arrives as a value rather than as a string, so there is no parse step here and no way for one to fail.",
      ],
      dedent`
        export function decodeResponse(body: unknown, modelId: string): ChatResponse {
          if (!isRecord(body)) {
            throw new MalformedResponseError("the response body was not an object", body);
          }

          const blocks = body["content"];
          if (!isArray(blocks)) {
            throw new MalformedResponseError("the response carried no content", body);
          }

          const warnings: string[] = [];
          const content: AssistantContent = blocks.flatMap((block) => decodeBlock(block, body));

          return {
            content,
            finishReason: decodeFinishReason(stringAt(body, "stop_reason"), warnings),
            usage: decodeUsage(body),
            modelId: stringAt(body, "model") ?? modelId,
            warnings,
            raw: body,
          };
        }
      `,
    ),
    documented(
      [
        "One content block, as no part or as one.",
        "A block of a kind this port has no part for is skipped rather than refused, and a thinking block is the case that matters: a response carrying one is otherwise perfectly good, and a caller who wants it has `raw`.",
      ],
      dedent`
        function decodeBlock(block: unknown, body: unknown): AssistantContent {
          if (!isRecord(block)) {
            throw new MalformedResponseError("a content block was not an object", body);
          }
          const kind = stringAt(block, "type");

          if (kind === "text") {
            const text = stringAt(block, "text");
            return text === undefined || text === "" ? [] : [{ type: "text", text }];
          }

          if (kind === "tool_use") {
            const callId = stringAt(block, "id");
            const toolName = stringAt(block, "name");
            if (callId === undefined || toolName === undefined) {
              throw new MalformedResponseError("a tool use carried no id or no name", body);
            }
            return [{ type: "tool-call", callId, toolName, input: block["input"] }];
          }

          return [];
        }
      `,
    ),
  );
}

function streamSection(shape: Shape): string {
  return sections(
    doc(
      "Decoding a stream: this format's events, as the port's parts.",
      "An async generator over already-framed events, so the two hard parts are separate: `sseEvents` knows about chunk boundaries and knows nothing about this format, and everything here knows about this format and nothing about the network. A test drives this with a string.",
    ),
    shape.anthropic ? anthropicStream() : openAiStream(),
    when(!shape.anthropic, openAiStreamHelpers()),
    parseEventHelper(),
  );
}

function openAiStream(): string {
  return documented(
    [
      "A framed stream, as parts.",
      "Two things this format makes the adapter work out. A tool call is identified by its index in an array, with the id and the name arriving only in the first delta that mentions it — so the index-to-call map below is what lets a later fragment be attributed. And there is no event for a call ending, so every call that started is ended here, once, after the stream is done.",
      "`[DONE]` is a sentinel rather than JSON, and a decoder that fed it to `JSON.parse` would fail on the last event of every successful stream.",
    ],
    dedent`
      export async function* decodeStream(chunks: AsyncIterable<string>): AsyncIterable<StreamPart> {
        const started = new Map<number, string>();
        const warnings: string[] = [];
        let finishReason: FinishReason = "other";
        let usage: Usage = { inputTokens: undefined, outputTokens: undefined };

        for await (const framed of sseEvents(chunks)) {
          if (framed.data === "[DONE]") {
            break;
          }
          const event = parseEvent(framed.data);
          if (event === undefined) {
            continue;
          }

          // Usage arrives on an event of its own, after the choices are finished.
          const reported = recordAt(event, "usage");
          if (reported !== undefined) {
            usage = {
              inputTokens: numberAt(reported, "prompt_tokens"),
              outputTokens: numberAt(reported, "completion_tokens"),
            };
          }

          const choices = event["choices"];
          if (!isArray(choices)) {
            continue;
          }

          for (const choice of choices) {
            if (!isRecord(choice)) {
              continue;
            }
            const reason = stringAt(choice, "finish_reason");
            if (reason !== undefined && reason !== "") {
              finishReason = decodeFinishReason(reason, warnings);
            }
            const delta = recordAt(choice, "delta");
            if (delta === undefined) {
              continue;
            }

            const text = stringAt(delta, "content");
            if (text !== undefined && text !== "") {
              yield { type: "text-delta", text };
            }

            const calls = delta["tool_calls"];
            if (!isArray(calls)) {
              continue;
            }
            for (const call of calls) {
              yield* toolCallParts(call, started);
            }
          }
        }

        for (const callId of started.values()) {
          yield { type: "tool-call-end", callId };
        }
        yield { type: "finish", finishReason, usage, warnings };
      }
    `,
  );
}

function openAiStreamHelpers(): string {
  return sections(
    documented(
      [
        "One tool call delta, as the parts it implies.",
        "The first delta for an index starts the call and carries its id and name; every later one carries a fragment of its input and nothing else. A fragment for an index that never started is a protocol violation and fails, because attributing it to the wrong call would be worse than refusing it.",
      ],
      dedent`
        function* toolCallParts(
          call: unknown,
          started: Map<number, string>,
        ): Generator<StreamPart> {
          if (!isRecord(call)) {
            return;
          }
          // Absent on services that send one call at a time, where the index is always the first.
          const index = numberAt(call, "index") ?? 0;
          const invoked = recordAt(call, "function");
          const existing = started.get(index);

          if (existing === undefined) {
            const callId = stringAt(call, "id");
            const toolName = invoked === undefined ? undefined : stringAt(invoked, "name");
            if (callId === undefined || toolName === undefined) {
              throw new MalformedResponseError("a streamed tool call had no id or no name", call);
            }
            started.set(index, callId);
            yield { type: "tool-call-start", callId, toolName };
          }

          const callId = started.get(index);
          const delta = invoked === undefined ? undefined : stringAt(invoked, "arguments");
          if (callId !== undefined && delta !== undefined && delta !== "") {
            yield { type: "tool-input-delta", callId, delta };
          }
        }
      `,
    ),
  );
}

function anthropicStream(): string {
  return documented(
    [
      "A framed stream, as parts.",
      "This format names its events twice — once in the `event:` field and once in the payload's `type` — and this reads the payload first, falling back to the field. They agree, but a proxy that reassembles the stream is more likely to drop the field than to rewrite the body.",
      "Content blocks are indexed, and a block's kind arrives only at its start, so the map below is what lets a stop event know whether it is ending a tool call or a run of text.",
    ],
    dedent`
      export async function* decodeStream(chunks: AsyncIterable<string>): AsyncIterable<StreamPart> {
        const calls = new Map<number, string>();
        const warnings: string[] = [];
        let finishReason: FinishReason = "other";
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;

        for await (const framed of sseEvents(chunks)) {
          const event = parseEvent(framed.data);
          if (event === undefined) {
            continue;
          }
          const kind = stringAt(event, "type") ?? framed.event;
          const index = numberAt(event, "index") ?? 0;

          if (kind === "message_start") {
            const message = recordAt(event, "message");
            const usage = message === undefined ? undefined : recordAt(message, "usage");
            if (usage !== undefined) {
              inputTokens = numberAt(usage, "input_tokens");
              outputTokens = numberAt(usage, "output_tokens");
            }
            continue;
          }

          if (kind === "content_block_start") {
            const block = recordAt(event, "content_block");
            if (block === undefined || stringAt(block, "type") !== "tool_use") {
              continue;
            }
            const callId = stringAt(block, "id");
            const toolName = stringAt(block, "name");
            if (callId === undefined || toolName === undefined) {
              throw new MalformedResponseError("a streamed tool use had no id or no name", block);
            }
            calls.set(index, callId);
            yield { type: "tool-call-start", callId, toolName };
            continue;
          }

          if (kind === "content_block_delta") {
            const delta = recordAt(event, "delta");
            if (delta === undefined) {
              continue;
            }
            const text = stringAt(delta, "text");
            if (text !== undefined && text !== "") {
              yield { type: "text-delta", text };
            }
            const partial = stringAt(delta, "partial_json");
            const callId = calls.get(index);
            if (partial !== undefined && partial !== "" && callId !== undefined) {
              yield { type: "tool-input-delta", callId, delta: partial };
            }
            continue;
          }

          if (kind === "content_block_stop") {
            const callId = calls.get(index);
            if (callId !== undefined) {
              calls.delete(index);
              yield { type: "tool-call-end", callId };
            }
            continue;
          }

          if (kind === "message_delta") {
            const delta = recordAt(event, "delta");
            const reason = delta === undefined ? undefined : stringAt(delta, "stop_reason");
            if (reason !== undefined && reason !== "") {
              finishReason = decodeFinishReason(reason, warnings);
            }
            // Output tokens are reported here rather than at the start, since that is the only
            // point at which they are known.
            const usage = recordAt(event, "usage");
            if (usage !== undefined) {
              outputTokens = numberAt(usage, "output_tokens") ?? outputTokens;
            }
          }
        }

        // A stream cut off mid-block still ends every call it started, so that a consumer folding
        // these parts never has to handle a call that has no end.
        for (const callId of calls.values()) {
          yield { type: "tool-call-end", callId };
        }
        yield { type: "finish", finishReason, usage: { inputTokens, outputTokens }, warnings };
      }
    `,
  );
}

function parseEventHelper(): string {
  return documented(
    [
      "One event's data, as an object.",
      "`undefined` for JSON that is not an object, since a stream carrying a bare string or a number at the top level is describing nothing this decoder can act on. Data that is not JSON at all is a protocol violation and fails, because silently skipping it would turn a broken stream into a short one.",
    ],
    dedent`
      function parseEvent(data: string): Readonly<Record<string, unknown>> | undefined {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch (cause) {
          throw new MalformedResponseError(
            \`a stream event's data was not JSON: \${String(cause)}\`,
            data,
          );
        }
        return isRecord(parsed) ? parsed : undefined;
      }
    `,
  );
}

function factorySection(names: Names, shape: Shape): string {
  const path = shape.anthropic ? "/messages" : "/chat/completions";
  const base = shape.anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
  const auth = shape.anthropic
    ? joinLines(
        '    "x-api-key": config.apiKey,',
        '    // Required by this format, and a version rather than a date range: a service that changed',
        '    // its shapes without a caller asking for a new version would break every adapter at once.',
        '    "anthropic-version": "2023-06-01",',
      )
    : "    authorization: `Bearer ${config.apiKey}`,";
  const encodeArgs = shape.anthropic ? "config" : "config.modelId";
  const returns = shape.streaming ? "StreamingChatModel" : "ChatModel";

  const streamMethod = when(
    shape.streaming,
    dedent`

      stream<const Tools extends readonly ToolDefinition[] = readonly []>(
        request: ChatRequest<Tools>,
      ): AsyncIterable<StreamPart> {
        // The request is not sent until the first part is asked for, which is what lets this
        // method return an iterable rather than a promise of one.
        const opened = async function* (): AsyncIterable<string> {
          const response = await send(request, true);
          if (response.body === null) {
            throw new MalformedResponseError("the streamed response carried no body", null);
          }
          yield* textChunks(response.body);
        };

        return decodeStream(opened());
      },
    `,
  );

  return sections(
    doc("The model."),
    documented(
      [
        `A ${names.wireFormat} model, over \`fetch\` or over whatever was supplied instead.`,
        "Everything above this line is a pure function of plain data, and everything below it is wiring. That is the split that makes the interesting half testable: the suite beside this file checks the encoding and the decoding against recorded bodies, and checks this function against a transport of six lines.",
      ],
      dedent`
        export function ${names.factory}(config: ${names.configType}): ${returns} {
          const url = \`\${config.baseUrl ?? "${base}"}${path}\`;
          const transport: FetchLike = config.fetch ?? fetch;

          const send = async <Tools extends readonly ToolDefinition[]>(
            request: ChatRequest<Tools>,
            streaming: boolean,
          ): Promise<FetchResponse> => {
            const response = await transport(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
            ${auth}
                // Last, so a caller can replace any of the above.
                ...config.headers,
              },
              body: JSON.stringify(encodeRequest(${encodeArgs}, request, streaming)),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            });

            if (!response.ok) {
              throw new ChatModelError(await failureMessage(response), {
                retryable: isRetryable(response.status),
                status: response.status,
              });
            }
            return response;
          };

          return {
            modelId: config.modelId,

            async generate<const Tools extends readonly ToolDefinition[] = readonly []>(
              request: ChatRequest<Tools>,
            ): Promise<ChatResponse> {
              const response = await send(request, false);
              return decodeResponse(await response.json(), config.modelId);
            },
        ${streamMethod}
          };
        }
      `,
    ),
    documented(
      [
        "Which failures are worth sending again.",
        "A timeout, a rate limit, and anything the service blames on itself. Everything else is the request's fault and will fail identically however many times it is sent — which is the distinction a retry needs and cannot make for itself.",
      ],
      dedent`
        function isRetryable(status: number): boolean {
          return status === 408 || status === 409 || status === 429 || status >= 500;
        }
      `,
    ),
    documented(
      [
        "What went wrong, as much of it as is worth putting in a message.",
        "The body is read as text rather than as JSON, because the whole point of this path is that the response was not what was expected — and truncated, because a provider that answers an error with a page of HTML should not put a page of HTML in a log line.",
      ],
      dedent`
        async function failureMessage(response: FetchResponse): Promise<string> {
          let detail = "";
          try {
            detail = (await response.text()).slice(0, 500);
          } catch {
            // A body that cannot be read is not worth failing over: the status is the useful part.
          }
          return \`the provider answered \${String(response.status)}\${detail === "" ? "" : \`: \${detail}\`}\`;
        }
      `,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The example: one tool call, answered, and the answer read back.
// ---------------------------------------------------------------------------------------------------

function example(context: RenderContext, names: Names, shape: Shape): string {
  const coreSpec = siblingSpecifier(context.conventions, names.coreStem);
  const bindingSpec = siblingSpecifier(context.conventions, names.bindingStem);

  return sections(
    exampleHeader(names, shape),
    joinLines(
      importsFrom(context.conventions, coreSpec, {
        values: [
          "assistantMessageOf",
          "isRecord",
          "textOf",
          "toolCallsOf",
          "toolMessage",
          "userMessage",
        ],
        types: [
          ...(shape.standalone && shape.streaming ? ["StreamingChatModel"] : ["ChatModel"]),
          ...(shape.standalone ? ["ChatRequest", "ChatResponse"] : []),
          "Message",
          "ToolDefinition",
          "ToolResultPart",
        ],
      }),
      when(
        !shape.standalone,
        importsFrom(context.conventions, bindingSpec, {
          values: [names.factory],
          types: ["FetchLike", "FetchResponse"],
        }),
      ),
    ),
    toolsFixture(),
    lookupTool(),
    shape.standalone ? scriptedModel(shape) : replayedTransport(names, shape),
    exampleFlow(names, shape),
  );
}

function exampleHeader(names: Names, shape: Shape): string {
  return doc(
    "One turn, one tool call, and the answer that follows it.",
    shape.standalone
      ? "There is no adapter in this scope, so the model here is written out — which is the shape of every test double a caller will write against this port, and the point of depending on the port rather than on a provider. Swapping in a real adapter changes the line that constructs it and nothing else."
      : `The transport replays two recorded ${names.wireFormat} bodies rather than reaching the network, so this file runs offline and produces the same answer every time. The line to change is \`fetch\`: leave it out and the model talks to the service.`,
    "The loop below is the whole of what a caller does with a tool: ask, see what was asked for, run it, send the result back, read the answer. Doing it more than once — and deciding when to stop — is what `tool-loop` is for.",
  );
}

function toolsFixture(): string {
  return documented(
    [
      "The tools this turn declares.",
      "`as const` matters, and the rule is worth knowing because it is invisible until it fails. A tools array written *inline* at the call site keeps its names literal on its own — that is what the `const` type parameter on `generate` is for. One hoisted into a variable widens at its own declaration, and nothing downstream can narrow it back: without the assertion here, `name` is `string`, the union of declared names is `string`, and `toolChoice` below would accept a tool that does not exist.",
      "`satisfies` after it rather than a type annotation before it, since an annotation would widen the names again — it checks the shape without giving up what was written.",
    ],
    dedent`
      const TOOLS = [
        {
          name: "lookupOrder",
          description: "Find one order by its reference.",
          inputSchema: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
            additionalProperties: false,
          },
        },
      ] as const satisfies readonly ToolDefinition[];

      const SYSTEM = "You answer questions about orders. Use the tools rather than guessing.";
    `,
  );
}

function lookupTool(): string {
  return documented(
    [
      "The tool itself, and the narrowing every tool needs.",
      "`input` is `unknown` because a JSON Schema is a value rather than a type, so this is where a model's idea of the arguments meets the code's. Returning a sentence rather than throwing on bad input is deliberate: the model reads what comes back, and a sentence is something it can act on.",
    ],
    dedent`
      function lookupOrder(input: unknown): string {
        if (!isRecord(input) || typeof input["orderId"] !== "string") {
          return "That call was missing a string orderId.";
        }
        const shipped: Readonly<Record<string, string>> = { "A-17": "Tuesday" };
        const day = shipped[input["orderId"]];
        return day === undefined ? "No such order." : \`Shipped on \${day}.\`;
      }
    `,
  );
}

function scriptedModel(shape: Shape): string {
  const stream = when(
    shape.streaming,
    dedent`
      ,

      // Present because the interface a caller asked for has it. A double that only ever answers
      // \`generate\` should say so by satisfying \`ChatModel\` instead.
      async *stream() {
        yield { type: "text-delta" as const, text: "not used by this example" };
      }
    `,
  );

  return documented(
    [
      "A model that answers from a script.",
      "The first turn asks for the tool; the second answers the question. Two lines of state, no network, and it satisfies the same interface a real adapter does — which is the property that makes a port worth having.",
    ],
    dedent`
      function scriptedModel(): ${shape.streaming ? "StreamingChatModel" : "ChatModel"} {
        let turn = 0;

        return {
          modelId: "scripted",

          generate<const Tools extends readonly ToolDefinition[] = readonly []>(
            request: ChatRequest<Tools>,
          ): Promise<ChatResponse> {
            turn += 1;
            const answered: ChatResponse =
              turn === 1
                ? {
                    content: [
                      {
                        type: "tool-call",
                        callId: "call-1",
                        toolName: "lookupOrder",
                        input: { orderId: "A-17" },
                      },
                    ],
                    finishReason: "tool-calls",
                    usage: { inputTokens: 42, outputTokens: 12 },
                    modelId: "scripted",
                    warnings: [],
                    raw: request,
                  }
                : {
                    content: [{ type: "text", text: "Order A-17 shipped on Tuesday." }],
                    finishReason: "stop",
                    usage: { inputTokens: 61, outputTokens: 9 },
                    modelId: "scripted",
                    warnings: [],
                    raw: request,
                  };

            return Promise.resolve(answered);
          }${stream},
        };
      }
    `,
  );
}

function replayedTransport(names: Names, shape: Shape): string {
  const bodies = shape.anthropic
    ? dedent`
        const CALLED_A_TOOL = {
          model: "claude-sonnet-4-5-20250929",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Let me look that up." },
            {
              type: "tool_use",
              id: "toolu_01",
              name: "lookupOrder",
              input: { orderId: "A-17" },
            },
          ],
          usage: { input_tokens: 42, output_tokens: 12 },
        };

        const ANSWERED = {
          model: "claude-sonnet-4-5-20250929",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Order A-17 shipped on Tuesday." }],
          usage: { input_tokens: 61, output_tokens: 9 },
        };
      `
    : dedent`
        const CALLED_A_TOOL = {
          model: "gpt-4o-2024-08-06",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_01",
                    type: "function",
                    function: { name: "lookupOrder", arguments: '{"orderId":"A-17"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 42, completion_tokens: 12 },
        };

        const ANSWERED = {
          model: "gpt-4o-2024-08-06",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Order A-17 shipped on Tuesday." },
            },
          ],
          usage: { prompt_tokens: 61, completion_tokens: 9 },
        };
      `;

  const body = when(
    shape.streaming,
    "\n    // Nothing here streams, and a body this transport never reads is honest about it.\n    body: null,",
  );

  return sections(
    documented(
      [
        `Two recorded ${names.wireFormat} bodies.`,
        "Trimmed to the fields this adapter reads, which is also a list of what it depends on: anything a service stopped sending that is not here would not be missed.",
      ],
      bodies,
    ),
    documented(
      [
        "A transport that replays them in order.",
        "Six lines, and it is the whole of what standing this up offline takes. A recording made against the real service goes here unchanged, which is the cheapest useful test a caller of this adapter can have.",
      ],
      dedent`
        function replaying(bodies: readonly unknown[]): FetchLike {
          let sent = 0;

          return (): Promise<FetchResponse> => {
            const body = bodies[sent] ?? bodies.at(-1);
            sent += 1;

            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(body),
              text: () => Promise.resolve(JSON.stringify(body)),${body}
            });
          };
        }
      `,
    ),
  );
}

function exampleFlow(names: Names, shape: Shape): string {
  const construct = shape.standalone
    ? "const model = scriptedModel();"
    : joinLines(
        `  const model = ${names.factory}({`,
        `    modelId: "${shape.anthropic ? "claude-sonnet-4-5" : "gpt-4o"}",`,
        '    apiKey: "placeholder",',
        "    // Remove this line and the same code talks to the service.",
        "    fetch: replaying([CALLED_A_TOOL, ANSWERED]),",
        "  });",
      );

  return documented(
    [
      "Ask, run whatever was asked for, and read the answer.",
      "`assistantMessageOf` is the line that matters: the model's turn goes back into the conversation *including its tool calls*, because a result whose call the conversation has no record of is rejected by every provider.",
    ],
    dedent`
      export async function ${names.exampleFn}(): Promise<string> {
      ${construct}

        const asked: readonly Message[] = [userMessage("When did order A-17 ship?")];

        const first = await model.generate({
          system: SYSTEM,
          messages: asked,
          tools: TOOLS,
          // \`{ mode: "tool", toolName: "lookupOrder" }\` would compile; any other name would not.
          toolChoice: { mode: "auto" },
        });

        const calls = toolCallsOf(first.content);
        if (calls.length === 0) {
          return textOf(first.content);
        }

        const results: readonly ToolResultPart[] = calls.map((call) => ({
          type: "tool-result",
          callId: call.callId,
          toolName: call.toolName,
          output: lookupOrder(call.input),
        }));

        const second = await model.generate({
          system: SYSTEM,
          messages: [...asked, assistantMessageOf(first), toolMessage(results)],
          tools: TOOLS,
        });

        return textOf(second.content);
      }
    `,
  );
}

// ---------------------------------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------------------------------

function tests(context: RenderContext, names: Names, shape: Shape): string {
  const coreSpec = siblingSpecifier(context.conventions, names.coreStem);
  const bindingSpec = siblingSpecifier(context.conventions, names.bindingStem);

  return sections(
    testHeader(names, shape),
    joinLines(
      frameworkImports(context.conventions),
      importsFrom(context.conventions, coreSpec, {
        values: [
          "ChatModelError",
          "MalformedResponseError",
          "assistantMessageOf",
          ...(shape.streaming ? ["sseEvents", "textChunks"] : []),
          "textOf",
          "toolCallsOf",
          "toolMessage",
          "userMessage",
        ],
        types: [
          ...(shape.streaming ? ["ByteStream"] : []),
          "ChatModel",
          "ChatRequest",
          "ChatResponse",
          ...(shape.streaming ? ["StreamPart"] : []),
          ...(shape.streaming && !shape.standalone ? ["StreamingChatModel"] : []),
          "ToolDefinition",
        ],
      }),
      when(
        !shape.standalone,
        importsFrom(context.conventions, bindingSpec, {
          values: [
            ...(shape.streaming ? ["decodeStream"] : []),
            "decodeResponse",
            "encodeRequest",
            names.factory,
          ],
          types: ["FetchLike", "FetchResponse"],
        }),
      ),
    ),
    testFixtures(names, shape),
    portCases(shape),
    when(shape.streaming, framingCases()),
    when(!shape.standalone, encodeCases(shape)),
    when(!shape.standalone, decodeCases(shape)),
    when(!shape.standalone && shape.streaming, streamCases(shape)),
    shape.standalone ? handModelCases() : transportCases(names, shape),
  );
}

function testHeader(names: Names, shape: Shape): string {
  return doc(
    shape.standalone
      ? "The port, and the model a caller writes against it."
      : `The port, and the ${names.wireFormat} adapter over recorded bodies.`,
    "Nothing here reaches the network, and nothing here is mocked either: the encoder and the decoder are pure functions, and the transport is a real implementation of the seam a real one implements. A failure means this code is wrong rather than that a stub disagreed with it.",
    when(
      shape.streaming,
      "The framing cases are the ones worth reading. Every one of them is a shape a real stream produces and a naive reader gets wrong — a field split across chunks, an event whose data spans several lines, a keep-alive comment, a stream that ends without its final blank line.",
    ),
  );
}

function testFixtures(names: Names, shape: Shape): string {
  const transport = when(
    !shape.standalone,
    sections(
      doc(
        "A transport that answers with one body, and records what it was asked.",
        "The recording is what lets the encoding be checked through the factory as well as directly — the request that went out is the one thing a caller cannot see from the outside.",
      ),
      dedent`
        interface Sent {
          readonly url: string;
          readonly headers: Readonly<Record<string, string>>;
          readonly body: unknown;
        }

        function answering(
          body: unknown,
          options: { readonly status?: number; readonly sse?: string } = {},
        ): { readonly fetch: FetchLike; readonly sent: Sent[] } {
          const sent: Sent[] = [];
          const status = options.status ?? 200;

          return {
            sent,
            fetch: (url, init): Promise<FetchResponse> => {
              sent.push({
                url,
                headers: init.headers,
                body: JSON.parse(init.body) as unknown,
              });

              return Promise.resolve({
                ok: status >= 200 && status < 300,
                status,
                json: () => Promise.resolve(body),
                text: () => Promise.resolve(JSON.stringify(body)),
                ${when(
                  shape.streaming,
                  "body: options.sse === undefined ? null : byteStream([bytesOf(options.sse)]),",
                )}
              });
            },
          };
        }
      `,
    ),
  );

  const streaming = when(
    shape.streaming,
    sections(
      doc("Streams, built from strings."),
      dedent`
        async function* chunksOf(...pieces: readonly string[]): AsyncIterable<string> {
          for (const piece of pieces) {
            yield piece;
            await Promise.resolve();
          }
        }

        async function drain<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
          const seen: T[] = [];
          for await (const event of events) {
            seen.push(event);
          }
          return seen;
        }
      `,
      documented(
        [
          "A byte stream over hand-written bytes.",
          "Bytes rather than text, because the one thing worth testing about the bridge is what it does when a character is split in half — and that cannot be expressed in terms of strings.",
        ],
        dedent`
          function byteStream(pieces: readonly (readonly number[])[]): ByteStream {
            let read = 0;

            return {
              getReader: () => ({
                read: () => {
                  const piece = pieces[read];
                  read += 1;
                  return Promise.resolve(
                    piece === undefined
                      ? { done: true }
                      : { done: false, value: Uint8Array.from(piece) },
                  );
                },
                releaseLock: () => undefined,
              }),
            };
          }

          function bytesOf(text: string): readonly number[] {
            return [...text].map((character) => character.charCodeAt(0));
          }
        `,
      ),
    ),
  );

  const events = when(
    shape.streaming && !shape.standalone,
    shape.anthropic
      ? documented(
          [
            "A stream, as this format sends one.",
            "Both the `event:` field and the payload's `type` are written out, because a real stream sends both and the decoder is documented to prefer the second.",
          ],
          dedent`
            function streamOf(...events: readonly Readonly<Record<string, unknown>>[]): string {
              return events
                .map((event) => \`event: \${String(event["type"])}\\ndata: \${JSON.stringify(event)}\\n\\n\`)
                .join("");
            }
          `,
        )
      : documented(
          [
            "A stream, as this format sends one.",
            "No `event:` field, because this format sends none — the payload's shape is the whole discriminant — and a `[DONE]` sentinel at the end, which is the one event that is not JSON.",
          ],
          dedent`
            function streamOf(...events: readonly Readonly<Record<string, unknown>>[]): string {
              return \`\${events
                .map((event) => \`data: \${JSON.stringify(event)}\\n\\n\`)
                .join("")}data: [DONE]\\n\\n\`;
            }
          `,
        ),
  );

  return sections(
    documented(
      [
        "The tools every case that needs one declares.",
        "`as const` because these are used through `typeof TOOLS` below, where the literal names are the whole point. A hoisted array without it widens `name` to `string` and the check it exists to prove passes for every name.",
      ],
      dedent`
        const TOOLS = [
          { name: "lookupOrder", inputSchema: { type: "object" } },
        ] as const satisfies readonly ToolDefinition[];
      `,
    ),
    documented(
      [
        "Whatever a call refused with.",
        "`toThrow` would do for a message, and a message is the wrong thing to assert on: which refusal it was is the contract, and its wording is not.",
      ],
      dedent`
        function refusalFrom(run: () => unknown): unknown {
          try {
            run();
          } catch (refusal) {
            return refusal;
          }
          throw new Error("expected a refusal, and the call returned");
        }

        async function rejectionFrom(run: () => Promise<unknown>): Promise<unknown> {
          try {
            await run();
          } catch (refusal) {
            return refusal;
          }
          throw new Error("expected a rejection, and the call resolved");
        }
      `,
    ),
    recordedBodies(names, shape),
    transport,
    streaming,
    events,
  );
}

function recordedBodies(names: Names, shape: Shape): string {
  if (shape.standalone) {
    return "";
  }

  return documented(
    [`One recorded ${names.wireFormat} body, carrying text and a tool call.`],
    shape.anthropic
      ? dedent`
          const RECORDED = {
            model: "claude-sonnet-4-5-20250929",
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "Looking." },
              { type: "tool_use", id: "toolu_01", name: "lookupOrder", input: { orderId: "A-17" } },
            ],
            usage: { input_tokens: 42, output_tokens: 12 },
          };
        `
      : dedent`
          const RECORDED = {
            model: "gpt-4o-2024-08-06",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "Looking.",
                  tool_calls: [
                    {
                      id: "call_01",
                      type: "function",
                      function: { name: "lookupOrder", arguments: '{"orderId":"A-17"}' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 42, completion_tokens: 12 },
          };
        `,
  );
}

/**
 * A `describe` with its cases inside it, one blank line apart.
 *
 * Joining the cases with newlines alone runs them together, and a suite whose tests touch is the one
 * shape of generated output reviewers reliably complain about. Prettier will not fix it: it preserves
 * blank lines rather than inserting them.
 */
function describeBlock(title: string, ...cases: readonly string[]): string {
  const body = cases.filter((one) => one.trim() !== "").join("\n\n");
  return body === "" ? "" : dedent`
    describe("${title}", () => {
    ${body}
    });
  `;
}

function testCase(title: string, body: string, async = false): string {
  return dedent`
    it("${title}", ${async ? "async " : ""}() => {
    ${body}
    });
  `;
}

function portCases(shape: Shape): string {
  return describeBlock(
    "the port's shapes",
    testCase(
      "a response goes back into the conversation with its tool calls intact",
      dedent`
        const answered: ChatResponse = {
          content: [
            { type: "text", text: "Looking." },
            { type: "tool-call", callId: "c1", toolName: "lookupOrder", input: { orderId: "A" } },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 2 },
          modelId: "m",
          warnings: [],
          raw: null,
        };

        const turn = assistantMessageOf(answered);

        expect(turn.role).toBe("assistant");
        // The same parts, not a summary of them: a loop that dropped the calls here would send
        // results the conversation has no record of, which every provider refuses.
        expect(turn.content).toEqual(answered.content);
      `,
    ),
    testCase(
      "text parts join with nothing between them",
      dedent`
        // One sentence that arrived in three pieces. A separator here appears mid-word.
        expect(
          textOf([
            { type: "text", text: "Order " },
            { type: "tool-call", callId: "c1", toolName: "lookupOrder", input: {} },
            { type: "text", text: "A-17 " },
            { type: "text", text: "shipped." },
          ]),
        ).toBe("Order A-17 shipped.");
      `,
    ),
    testCase(
      "tool calls are read out of a mixed turn in order",
      dedent`
        const calls = toolCallsOf([
          { type: "tool-call", callId: "c1", toolName: "lookupOrder", input: {} },
          { type: "text", text: "and" },
          { type: "tool-call", callId: "c2", toolName: "lookupOrder", input: {} },
        ]);

        expect(calls.map((call) => call.callId)).toEqual(["c1", "c2"]);
      `,
    ),
    testCase(
      "a tool result is paired by call id rather than by position",
      dedent`
        const message = toolMessage([
          { type: "tool-result", callId: "c2", toolName: "lookupOrder", output: "second" },
          { type: "tool-result", callId: "c1", toolName: "lookupOrder", output: "first" },
        ]);

        expect(message.role).toBe("tool");
        expect(message.content[0]?.callId).toBe("c2");
      `,
    ),
    testCase(
      "a tool name has to be one the request declared",
      dedent`
        // Type-level, and the reason the suite carries it: nothing at run time can tell the
        // difference, so a regression here would otherwise be invisible until a provider rejected
        // the request.
        const named: ChatRequest<typeof TOOLS> = {
          messages: [userMessage("hi")],
          tools: TOOLS,
          toolChoice: { mode: "tool", toolName: "lookupOrder" },
        };
        expect(named.toolChoice?.mode).toBe("tool");

        const wrong: ChatRequest<typeof TOOLS> = {
          messages: [],
          tools: TOOLS,
          toolChoice: {
            mode: "tool",
            // @ts-expect-error no tool of this name was declared
            toolName: "cancelOrder",
          },
        };
        expect(wrong.messages).toHaveLength(0);

        const none: ChatRequest = {
          messages: [],
          toolChoice: {
            mode: "tool",
            // @ts-expect-error a request that declared no tools can name none
            toolName: "lookupOrder",
          },
        };
        expect(none.messages).toHaveLength(0);
      `,
    ),
    testCase(
      "tools written inline keep their names without an assertion",
      dedent`
        // This is what the \`const\` type parameter on \`generate\` buys, and the reason it is there:
        // ordinary code, no \`as const\`, and the name still checked. A tools array hoisted into a
        // variable is the case that needs the assertion, because it widens where it is declared.
        const model: ChatModel = {
          modelId: "double",
          generate: (): Promise<ChatResponse> =>
            Promise.resolve({
              content: [],
              finishReason: "stop",
              usage: { inputTokens: undefined, outputTokens: undefined },
              modelId: "double",
              warnings: [],
              raw: null,
            }),
        };

        await model.generate({
          messages: [],
          tools: [{ name: "inlineOnly", inputSchema: {} }],
          toolChoice: { mode: "tool", toolName: "inlineOnly" },
        });

        await model.generate({
          messages: [],
          tools: [{ name: "inlineOnly", inputSchema: {} }],
          toolChoice: {
            mode: "tool",
            // @ts-expect-error the array beside this one declares no such tool
            toolName: "lookupOrder",
          },
        });

        expect(model.modelId).toBe("double");
      `,
      true,
    ),
    when(
      shape.standalone,
      sections(
        testCase(
          "a user message is one text part",
          dedent`
            expect(userMessage("hi")).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
          `,
        ),
        testCase(
          "a malformed answer is never worth asking for again",
          dedent`
            const malformed = new MalformedResponseError("not the documented shape", { oh: "no" });

            // Sending the same request to get the same broken answer turns one bug into a rate
            // limit, so this is the one failure a retry has to leave alone.
            expect(malformed).toBeInstanceOf(ChatModelError);
            expect(malformed.retryable).toBe(false);
            // Kept, because the only useful thing to do with one of these is look at it.
            expect(malformed.body).toEqual({ oh: "no" });

            // Everything else is the adapter's call, since it is the only code that saw the status.
            const rateLimited = new ChatModelError("slow down", { retryable: true, status: 429 });
            expect(rateLimited.retryable).toBe(true);
            expect(rateLimited.status).toBe(429);
          `,
        ),
      ),
    ),
  );
}

function framingCases(): string {
  return describeBlock(
    "framing a stream",
    testCase(
      "an event split across two chunks arrives whole",
      dedent`
        // The failure this pins is the common one: a reader that parses each chunk on its own sees
        // half a line and either throws or drops it.
        const framed = await drain(sseEvents(chunksOf('data: {"a"', ':1}\\n\\n')));

        expect(framed).toEqual([{ event: undefined, data: '{"a":1}' }]);
      `,
      true,
    ),
    testCase(
      "several events in one chunk arrive separately",
      dedent`
        const framed = await drain(sseEvents(chunksOf("data: one\\n\\ndata: two\\n\\n")));

        expect(framed.map((event) => event.data)).toEqual(["one", "two"]);
      `,
      true,
    ),
    testCase(
      "an event's data lines are joined with newlines",
      dedent`
        // What the specification says, and what nobody implements until a provider sends one.
        const framed = await drain(sseEvents(chunksOf("data: first\\ndata: second\\n\\n")));

        expect(framed).toEqual([{ event: undefined, data: "first\\nsecond" }]);
      `,
      true,
    ),
    testCase(
      "the event field is reported where the stream sends one",
      dedent`
        const framed = await drain(sseEvents(chunksOf("event: ping\\ndata: {}\\n\\n")));

        expect(framed[0]?.event).toBe("ping");
      `,
      true,
    ),
    testCase(
      "comments and keep-alives frame nothing",
      dedent`
        // A blank line with no data before it is how every keep-alive arrives. Yielding an empty
        // event for each one would make every consumer filter them out again.
        const framed = await drain(sseEvents(chunksOf(": keep-alive\\n\\n\\ndata: real\\n\\n")));

        expect(framed.map((event) => event.data)).toEqual(["real"]);
      `,
      true,
    ),
    testCase(
      "carriage returns belong to the framing rather than to the data",
      dedent`
        const framed = await drain(sseEvents(chunksOf("data: value\\r\\n\\r\\n")));

        expect(framed).toEqual([{ event: undefined, data: "value" }]);
      `,
      true,
    ),
    testCase(
      "one leading space belongs to the syntax and a second does not",
      dedent`
        const framed = await drain(sseEvents(chunksOf("data:  padded\\n\\n")));

        expect(framed[0]?.data).toBe(" padded");
      `,
      true,
    ),
    testCase(
      "a stream that ends without a blank line still sent its last event",
      dedent`
        // Every provider does this, and a reader that waits for the terminator loses the last event
        // of every successful stream.
        const framed = await drain(sseEvents(chunksOf("data: first\\n\\ndata: last")));

        expect(framed.map((event) => event.data)).toEqual(["first", "last"]);
      `,
      true,
    ),
    testCase(
      "a character split across two reads is decoded whole",
      dedent`
        // "€" is three bytes. Decoding each read on its own puts a replacement character at the
        // boundary, which is a bug that only appears in the languages nobody tested in.
        const text: string[] = [];
        for await (const chunk of textChunks(byteStream([[0xe2, 0x82], [0xac]]))) {
          text.push(chunk);
        }

        expect(text.join("")).toBe("€");
      `,
      true,
    ),
  );
}

/**
 * The field each format sets from the `streaming` flag, and the value a caller's override of it
 * should reach the body as. It is the last field either encoder writes before `providerOptions`,
 * which makes it the one that pins the merge order.
 */
function streamOverride(shape: Shape): { readonly field: string; readonly expected: string } {
  return shape.anthropic
    ? { field: "stream", expected: "false" }
    : { field: "stream_options", expected: "{ include_usage: false }" };
}

function streamingEncoded(shape: Shape): string {
  const override = shape.anthropic
    ? "{ stream: false }"
    : "{ stream_options: { include_usage: false } }";
  const request = `{ messages: [], providerOptions: ${override} }`;

  return shape.anthropic
    ? `encodeRequest({ modelId: "m" }, ${request}, true)`
    : `encodeRequest("m", ${request}, true)`;
}

function encodeCases(shape: Shape): string {
  const encoded = shape.anthropic
    ? 'encodeRequest({ modelId: "m" }, request, false)'
    : 'encodeRequest("m", request, false)';

  return describeBlock(
    "encoding a request",
    shape.anthropic
      ? testCase(
          "the system prompt is a field of its own",
          dedent`
            const body = encodeRequest(
              { modelId: "m" },
              { system: "be brief", messages: [userMessage("hi")] },
              false,
            );

            expect(body["system"]).toBe("be brief");
            // And not a message: this format has nowhere in the list to put one.
            expect(body["messages"]).toEqual([
              { role: "user", content: [{ type: "text", text: "hi" }] },
            ]);
          `,
        )
      : testCase(
          "the system prompt becomes the first message",
          dedent`
            const body = encodeRequest("m", { system: "be brief", messages: [userMessage("hi")] }, false);

            expect(body["messages"]).toEqual([
              { role: "system", content: "be brief" },
              { role: "user", content: "hi" },
            ]);
          `,
        ),
    shape.anthropic
      ? testCase(
          "a required output limit is supplied when the request names none",
          dedent`
            const defaulted = encodeRequest({ modelId: "m" }, { messages: [] }, false);
            expect(defaulted["max_tokens"]).toBe(${String(DEFAULT_MAX_TOKENS)});

            const configured = encodeRequest(
              { modelId: "m", maxOutputTokens: 100 },
              { messages: [] },
              false,
            );
            expect(configured["max_tokens"]).toBe(100);

            // The request wins over the configuration, which wins over the default.
            const asked = encodeRequest(
              { modelId: "m", maxOutputTokens: 100 },
              { messages: [], maxOutputTokens: 7 },
              false,
            );
            expect(asked["max_tokens"]).toBe(7);
          `,
        )
      : testCase(
          "an output limit is sent only when the request names one",
          dedent`
            expect(encodeRequest("m", { messages: [] }, false)["max_completion_tokens"]).toBeUndefined();
            expect(
              encodeRequest("m", { messages: [], maxOutputTokens: 7 }, false)["max_completion_tokens"],
            ).toBe(7);
          `,
        ),
    shape.anthropic
      ? testCase(
          "tool results become blocks in a user turn, merged with the text beside them",
          dedent`
            const body = encodeRequest(
              { modelId: "m" },
              {
                messages: [
                  toolMessage([
                    { type: "tool-result", callId: "c1", toolName: "lookupOrder", output: "ok" },
                    {
                      type: "tool-result",
                      callId: "c2",
                      toolName: "lookupOrder",
                      output: { note: "structured" },
                      failed: true,
                    },
                  ]),
                  userMessage("and now?"),
                ],
              },
              false,
            );

            // One turn, not two: this format alternates, and two consecutive user messages are
            // refused by it.
            expect(body["messages"]).toEqual([
              {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "c1", content: "ok" },
                  {
                    type: "tool_result",
                    tool_use_id: "c2",
                    content: '{"note":"structured"}',
                    is_error: true,
                  },
                  { type: "text", text: "and now?" },
                ],
              },
            ]);
          `,
        )
      : testCase(
          "each tool result is a message of its own, keyed to the call it answers",
          dedent`
            const body = encodeRequest(
              "m",
              {
                messages: [
                  toolMessage([
                    { type: "tool-result", callId: "c1", toolName: "lookupOrder", output: "ok" },
                    {
                      type: "tool-result",
                      callId: "c2",
                      toolName: "lookupOrder",
                      output: { note: "structured" },
                      failed: true,
                    },
                  ]),
                ],
              },
              false,
            );

            // Two messages, because this format pairs a result with a call rather than with a turn.
            // \`failed\` is gone, and this is the format with no field for it.
            expect(body["messages"]).toEqual([
              { role: "tool", tool_call_id: "c1", content: "ok" },
              { role: "tool", tool_call_id: "c2", content: '{"note":"structured"}' },
            ]);
          `,
        ),
    shape.anthropic
      ? testCase(
          "an assistant turn's tool call carries its input as a value",
          dedent`
            const body = encodeRequest(
              { modelId: "m" },
              {
                messages: [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "tool-call",
                        callId: "c1",
                        toolName: "lookupOrder",
                        input: { orderId: "A-17" },
                      },
                    ],
                  },
                ],
              },
              false,
            );

            expect(body["messages"]).toEqual([
              {
                role: "assistant",
                content: [
                  { type: "tool_use", id: "c1", name: "lookupOrder", input: { orderId: "A-17" } },
                ],
              },
            ]);
          `,
        )
      : testCase(
          "an assistant turn with only tool calls sends no content",
          dedent`
            const body = encodeRequest(
              "m",
              {
                messages: [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "tool-call",
                        callId: "c1",
                        toolName: "lookupOrder",
                        input: { orderId: "A-17" },
                      },
                    ],
                  },
                ],
              },
              false,
            );

            // \`null\` rather than \`""\`: an empty string is something the model said.
            expect(body["messages"]).toEqual([
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    // A JSON string, which is what makes a round trip through this format lossy.
                    function: { name: "lookupOrder", arguments: '{"orderId":"A-17"}' },
                  },
                ],
              },
            ]);
          `,
        ),
    testCase(
      "each way of choosing a tool has its own spelling",
      shape.anthropic
        ? dedent`
            const choiceOf = (mode: "auto" | "none" | "required"): unknown =>
              encodeRequest({ modelId: "m" }, { messages: [], tools: TOOLS, toolChoice: { mode } }, false)[
                "tool_choice"
              ];

            expect(choiceOf("auto")).toEqual({ type: "auto" });
            expect(choiceOf("none")).toEqual({ type: "none" });
            // "required" is spelled "any" here, which is exactly the sort of difference the port absorbs.
            expect(choiceOf("required")).toEqual({ type: "any" });
            expect(
              encodeRequest(
                { modelId: "m" },
                { messages: [], tools: TOOLS, toolChoice: { mode: "tool", toolName: "lookupOrder" } },
                false,
              )["tool_choice"],
            ).toEqual({ type: "tool", name: "lookupOrder" });
          `
        : dedent`
            const choiceOf = (mode: "auto" | "none" | "required"): unknown =>
              encodeRequest("m", { messages: [], tools: TOOLS, toolChoice: { mode } }, false)[
                "tool_choice"
              ];

            expect(choiceOf("auto")).toBe("auto");
            expect(choiceOf("none")).toBe("none");
            expect(choiceOf("required")).toBe("required");
            expect(
              encodeRequest(
                "m",
                { messages: [], tools: TOOLS, toolChoice: { mode: "tool", toolName: "lookupOrder" } },
                false,
              )["tool_choice"],
            ).toEqual({ type: "function", function: { name: "lookupOrder" } });
          `,
    ),
    testCase(
      "provider options are merged last, so they can override what this adapter set",
      dedent`
        const request: ChatRequest = {
          messages: [],
          temperature: 0.1,
          providerOptions: { temperature: 0.9, seed: 7 },
        };
        const body = ${encoded};

        // The escape hatch wins on purpose: a caller who needs one unusual field should not have
        // to abandon the adapter to send it.
        expect(body["temperature"]).toBe(0.9);
        expect(body["seed"]).toBe(7);

        // Including the fields set last, which are the ones a hand-written merge tends to leave
        // out of reach.
        const streamed = ${streamingEncoded(shape)};
        expect(streamed[${JSON.stringify(streamOverride(shape).field)}]).toEqual(
          ${streamOverride(shape).expected}
        );
      `,
    ),
    testCase(
      "a request that declares no tools sends no tools field",
      dedent`
        const request: ChatRequest = { messages: [userMessage("hi")] };
        const body = ${encoded};

        // An empty array is not the same as an absent field: some services refuse the first.
        expect(body["tools"]).toBeUndefined();
        expect(body["tool_choice"]).toBeUndefined();
      `,
    ),
  );
}

function decodeCases(shape: Shape): string {
  return describeBlock(
    "decoding a response",
    testCase(
      "text, a tool call, the finish reason and the usage all come out of one body",
      dedent`
        const response = decodeResponse(RECORDED, "asked-for");

        expect(textOf(response.content)).toBe("Looking.");
        expect(response.finishReason).toBe("tool-calls");
        expect(response.usage).toEqual({ inputTokens: 42, outputTokens: 12 });
        // What answered rather than what was asked for, which a gateway can change.
        expect(response.modelId).toBe(${shape.anthropic ? '"claude-sonnet-4-5-20250929"' : '"gpt-4o-2024-08-06"'});
        expect(response.warnings).toEqual([]);
        expect(response.raw).toBe(RECORDED);

        const [call] = toolCallsOf(response.content);
        expect(call?.callId).toBe(${shape.anthropic ? '"toolu_01"' : '"call_01"'});
        expect(call?.toolName).toBe("lookupOrder");
        // A value, whichever form it arrived in.
        expect(call?.input).toEqual({ orderId: "A-17" });
      `,
    ),
    testCase(
      "a model this port has no case for is a warning rather than a failure",
      shape.anthropic
        ? dedent`
            const response = decodeResponse(
              { ...RECORDED, stop_reason: "something_new" },
              "asked-for",
            );

            // Refusing a usable response over a string released last week would be the wrong trade,
            // and the original is kept where a caller can see it.
            expect(response.finishReason).toBe("other");
            expect(response.warnings).toHaveLength(1);
          `
        : dedent`
            const response = decodeResponse(
              { ...RECORDED, choices: [{ index: 0, finish_reason: "something_new", message: {} }] },
              "asked-for",
            );

            expect(response.finishReason).toBe("other");
            expect(response.warnings).toHaveLength(1);
          `,
    ),
    testCase(
      "a missing finish reason is not a warning",
      shape.anthropic
        ? dedent`
            // Absent is silence, not a value this port failed to recognise.
            const response = decodeResponse({ content: [] }, "asked-for");

            expect(response.finishReason).toBe("other");
            expect(response.warnings).toEqual([]);
          `
        : dedent`
            const response = decodeResponse({ choices: [{ message: {} }] }, "asked-for");

            expect(response.finishReason).toBe("other");
            expect(response.warnings).toEqual([]);
          `,
    ),
    testCase(
      "a usage the provider did not report is undefined rather than zero",
      shape.anthropic
        ? dedent`
            // Zero would be a claim. A caller adding these up needs to know the difference.
            const response = decodeResponse({ content: [] }, "asked-for");

            expect(response.usage).toEqual({ inputTokens: undefined, outputTokens: undefined });
          `
        : dedent`
            const response = decodeResponse({ choices: [{ message: {} }] }, "asked-for");

            expect(response.usage).toEqual({ inputTokens: undefined, outputTokens: undefined });
          `,
    ),
    testCase(
      "an empty text is no part at all",
      shape.anthropic
        ? dedent`
            const response = decodeResponse({ content: [{ type: "text", text: "" }] }, "m");

            // Otherwise a response with nothing in it has one part, and every check on \`length\`
            // disagrees with every check on \`textOf\`.
            expect(response.content).toHaveLength(0);
          `
        : dedent`
            const response = decodeResponse({ choices: [{ message: { content: "" } }] }, "m");

            expect(response.content).toHaveLength(0);
          `,
    ),
    when(
      shape.anthropic,
      testCase(
        "a block of a kind this port has no part for is skipped",
        dedent`
          const response = decodeResponse(
            {
              content: [
                { type: "thinking", thinking: "…" },
                { type: "text", text: "answer" },
              ],
            },
            "m",
          );

          // Skipped rather than refused: the response is otherwise good, and \`raw\` still has it.
          expect(textOf(response.content)).toBe("answer");
          expect(response.content).toHaveLength(1);
        `,
      ),
    ),
    when(
      !shape.anthropic,
      testCase(
        "a tool called with no arguments is called with an empty object",
        dedent`
          const response = decodeResponse(
            {
              choices: [
                {
                  message: {
                    tool_calls: [
                      { id: "c1", type: "function", function: { name: "ping", arguments: "" } },
                    ],
                  },
                },
              ],
            },
            "m",
          );

          // Some services send "" and others "{}" for a tool with no parameters, and a caller
          // should not have to know which one they are talking to.
          expect(toolCallsOf(response.content)[0]?.input).toEqual({});
        `,
      ),
    ),
    when(
      !shape.anthropic,
      testCase(
        "arguments that are not JSON are a protocol violation",
        dedent`
          const refusal = refusalFrom(() =>
            decodeResponse(
              {
                choices: [
                  {
                    message: {
                      tool_calls: [
                        { id: "c1", type: "function", function: { name: "ping", arguments: "{oh" } },
                      ],
                    },
                  },
                ],
              },
              "m",
            ),
          );

          // This format promises a JSON string. A model that produced valid JSON of the wrong
          // *shape* is a different problem, and not this function's.
          expect(refusal).toBeInstanceOf(MalformedResponseError);
        `,
      ),
    ),
    testCase(
      "a body that is not the shape this format documents is refused, not guessed at",
      dedent`
        for (const body of [null, "a string", 42, {}${shape.anthropic ? "" : ', { choices: [] }, { choices: [{}] }'}]) {
          expect(refusalFrom(() => decodeResponse(body, "m"))).toBeInstanceOf(MalformedResponseError);
        }
      `,
    ),
    testCase(
      "a malformed body is never worth sending again",
      dedent`
        const refusal = refusalFrom(() => decodeResponse(null, "m"));

        // The same request would produce the same answer, so a retry here turns one bug into a
        // rate limit.
        expect(refusal).toBeInstanceOf(ChatModelError);
        expect((refusal as ChatModelError).retryable).toBe(false);
        expect((refusal as MalformedResponseError).body).toBe(null);
      `,
    ),
    when(
      shape.anthropic,
      testCase(
        "a tool use with no id is refused",
        dedent`
          expect(
            refusalFrom(() =>
              decodeResponse({ content: [{ type: "tool_use", name: "ping" }] }, "m"),
            ),
          ).toBeInstanceOf(MalformedResponseError);
        `,
      ),
      testCase(
        "a tool call with no id is refused",
        dedent`
          expect(
            refusalFrom(() =>
              decodeResponse(
                { choices: [{ message: { tool_calls: [{ function: { name: "ping" } }] } }] },
                "m",
              ),
            ),
          ).toBeInstanceOf(MalformedResponseError);
        `,
      ),
    ),
  );
}

function streamCases(shape: Shape): string {
  const fullStream = shape.anthropic
    ? dedent`
        const stream = streamOf(
          { type: "message_start", message: { usage: { input_tokens: 42, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Look" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ing." } },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_01", name: "lookupOrder", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"orderId"' },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: ':"A-17"}' },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 12 },
          },
          { type: "message_stop" },
        );
      `
    : dedent`
        const stream = streamOf(
          { choices: [{ index: 0, delta: { content: "Look" } }] },
          { choices: [{ index: 0, delta: { content: "ing." } }] },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_01",
                      type: "function",
                      function: { name: "lookupOrder", arguments: '{"orderId"' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: ':"A-17"}' } }] },
              },
            ],
          },
          { choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
          { choices: [], usage: { prompt_tokens: 42, completion_tokens: 12 } },
        );
      `;

  const cutOff = shape.anthropic
    ? dedent`
        const stream = streamOf(
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_01", name: "lookupOrder", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"or' },
          },
        );
      `
    : dedent`
        const stream = streamOf({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_01",
                    type: "function",
                    function: { name: "lookupOrder", arguments: '{"or' },
                  },
                ],
              },
            },
          ],
        });
      `;

  return describeBlock(
    "decoding a stream",
    testCase(
      "text, a tool call assembled from fragments, and a finish come out in order",
      dedent`
        ${fullStream}

        const parts = await drain(decodeStream(chunksOf(stream)));

        expect(parts).toEqual([
          { type: "text-delta", text: "Look" },
          { type: "text-delta", text: "ing." },
          { type: "tool-call-start", callId: ${shape.anthropic ? '"toolu_01"' : '"call_01"'}, toolName: "lookupOrder" },
          // Fragments, not a value: they are not parseable until the last one, which is why
          // assembling them is a separate job.
          { type: "tool-input-delta", callId: ${shape.anthropic ? '"toolu_01"' : '"call_01"'}, delta: '{"orderId"' },
          { type: "tool-input-delta", callId: ${shape.anthropic ? '"toolu_01"' : '"call_01"'}, delta: ':"A-17"}' },
          { type: "tool-call-end", callId: ${shape.anthropic ? '"toolu_01"' : '"call_01"'} },
          {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 42, outputTokens: 12 },
            warnings: [],
          },
        ]);
      `,
      true,
    ),
    testCase(
      "a stream cut off mid-call still ends every call it started",
      dedent`
        ${cutOff}

        const parts = await drain(decodeStream(chunksOf(stream)));

        // A consumer folding these parts should never have to handle a call with no end, so the
        // guarantee holds even where the stream stopped without saying so.
        expect(parts.map((part) => part.type)).toEqual([
          "tool-call-start",
          "tool-input-delta",
          "tool-call-end",
          "finish",
        ]);
      `,
      true,
    ),
    testCase(
      "a stream arriving one byte at a time decodes to the same parts",
      dedent`
        ${fullStream}

        // The framing is what this proves: the decoder sees the same events however the network
        // chose to break them up.
        const whole = await drain(decodeStream(chunksOf(stream)));
        const shredded = await drain(decodeStream(chunksOf(...[...stream])));

        expect(shredded).toEqual(whole);
      `,
      true,
    ),
    when(
      !shape.anthropic,
      testCase(
        "the sentinel that ends the stream is not treated as JSON",
        dedent`
          // \`[DONE]\` is the last event of every successful stream, and a decoder that parsed it
          // would fail on all of them.
          const parts = await drain(decodeStream(chunksOf("data: [DONE]\\n\\n")));

          expect(parts).toEqual([
            {
              type: "finish",
              finishReason: "other",
              usage: { inputTokens: undefined, outputTokens: undefined },
              warnings: [],
            },
          ]);
        `,
        true,
      ),
    ),
    testCase(
      "an event whose data is not JSON is refused",
      dedent`
        const refusal = await rejectionFrom(() =>
          drain(decodeStream(chunksOf("data: {oh\\n\\n"))),
        );

        // Skipping it would turn a broken stream into a short one, which is worse: the caller
        // would get a plausible answer that is missing its middle.
        expect(refusal).toBeInstanceOf(MalformedResponseError);
      `,
      true,
    ),
  );
}

function handModelCases(): string {
  return describeBlock(
    "a model written by hand",
    testCase(
      "the port is satisfiable without a provider, and a tool loop runs against it",
      dedent`
        const answers: readonly ChatResponse[] = [
          {
            content: [
              { type: "tool-call", callId: "c1", toolName: "lookupOrder", input: { orderId: "A" } },
            ],
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1 },
            modelId: "double",
            warnings: [],
            raw: null,
          },
          {
            content: [{ type: "text", text: "Shipped on Tuesday." }],
            finishReason: "stop",
            usage: { inputTokens: 2, outputTokens: 2 },
            modelId: "double",
            warnings: [],
            raw: null,
          },
        ];
        // Widened in its tools, which is what lets a generic method record its own argument: the
        // request's tool names are strings, and everything built from them follows.
        const asked: ChatRequest<readonly ToolDefinition[]>[] = [];
        let turn = 0;

        // Nine lines, and it is a complete model. That is the property worth having: a caller's
        // own code is testable without a network, a key, or a recorded body.
        const model: ChatModel = {
          modelId: "double",
          generate: <const Tools extends readonly ToolDefinition[] = readonly []>(
            request: ChatRequest<Tools>,
          ): Promise<ChatResponse> => {
            asked.push(request);
            const answer = answers[turn];
            turn += 1;
            return answer === undefined
              ? Promise.reject(new Error("asked more often than the script answers"))
              : Promise.resolve(answer);
          },
        };

        const first = await model.generate({ messages: [userMessage("when?")], tools: TOOLS });
        const calls = toolCallsOf(first.content);
        expect(calls).toHaveLength(1);

        const second = await model.generate({
          messages: [
            userMessage("when?"),
            assistantMessageOf(first),
            toolMessage(
              calls.map((call) => ({
                type: "tool-result" as const,
                callId: call.callId,
                toolName: call.toolName,
                output: "Tuesday",
              })),
            ),
          ],
          tools: TOOLS,
        });

        expect(textOf(second.content)).toBe("Shipped on Tuesday.");
        // The second turn carried the whole conversation, tool calls included.
        expect(asked[1]?.messages).toHaveLength(3);
      `,
      true,
    ),
  );
}

function transportCases(names: Names, shape: Shape): string {
  const construct = `${names.factory}({ modelId: "m", apiKey: "placeholder", fetch: transport.fetch })`;
  const authHeader = shape.anthropic ? "x-api-key" : "authorization";
  const authValue = shape.anthropic ? '"placeholder"' : '"Bearer placeholder"';

  return describeBlock(
    "the model over a transport",
    testCase(
      "a request is encoded, sent to the documented path, and decoded back",
      dedent`
        const transport = answering(RECORDED);
        const model = ${construct};

        const response = await model.generate({ messages: [userMessage("when?")], tools: TOOLS });

        expect(response.finishReason).toBe("tool-calls");
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]?.url).toBe(
          "${shape.anthropic ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions"}",
        );
      `,
      true,
    ),
    testCase(
      "the key and the headers this format requires are set",
      dedent`
        const transport = answering(RECORDED);
        const model = ${construct};
        await model.generate({ messages: [] });

        const headers = transport.sent[0]?.headers ?? {};
        expect(headers["${authHeader}"]).toBe(${authValue});
        expect(headers["content-type"]).toBe("application/json");
        ${when(shape.anthropic, 'expect(headers["anthropic-version"]).toBe("2023-06-01");')}
      `,
      true,
    ),
    testCase(
      "a caller's headers are merged over the ones this adapter set",
      dedent`
        const transport = answering(RECORDED);
        const model = ${names.factory}({
          modelId: "m",
          apiKey: "placeholder",
          headers: { "content-type": "application/json; charset=utf-8", "x-trace": "1" },
          fetch: transport.fetch,
        });
        await model.generate({ messages: [] });

        const headers = transport.sent[0]?.headers ?? {};
        // Last wins, deliberately: a caller behind a gateway that needs a different header should
        // not have to fork the adapter to send one.
        expect(headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(headers["x-trace"]).toBe("1");
      `,
      true,
    ),
    testCase(
      "a base url is honoured, which is what makes a compatible service reachable",
      dedent`
        const transport = answering(RECORDED);
        const model = ${names.factory}({
          modelId: "m",
          apiKey: "placeholder",
          baseUrl: "https://gateway.internal/v9",
          fetch: transport.fetch,
        });
        await model.generate({ messages: [] });

        expect(transport.sent[0]?.url).toBe("https://gateway.internal/v9${shape.anthropic ? "/messages" : "/chat/completions"}");
      `,
      true,
    ),
    testCase(
      "a status the service blames on itself is retryable and one it blames on the request is not",
      dedent`
        for (const status of [429, 500, 503, 408]) {
          const refusal = await rejectionFrom(() =>
            answeringAt(status).generate({ messages: [] }),
          );
          expect(refusal).toBeInstanceOf(ChatModelError);
          expect((refusal as ChatModelError).retryable).toBe(true);
          expect((refusal as ChatModelError).status).toBe(status);
        }

        for (const status of [400, 401, 403, 404, 422]) {
          const refusal = await rejectionFrom(() =>
            answeringAt(status).generate({ messages: [] }),
          );
          // Sending this one again produces the same answer, which is the distinction a retry
          // needs and cannot make for itself.
          expect((refusal as ChatModelError).retryable).toBe(false);
        }
      `,
      true,
    ),
    testCase(
      "a failure carries what the service said about it",
      dedent`
        const transport = answering({ error: { message: "no such model" } }, { status: 404 });
        const model = ${construct};

        const refusal = await rejectionFrom(() => model.generate({ messages: [] }));

        // The body, not just the status: a 404 on its own does not say which of the two things in
        // the request was not found.
        expect(String(refusal).includes("no such model")).toBe(true);
        expect(String(refusal).includes("404")).toBe(true);
      `,
      true,
    ),
    when(
      shape.streaming,
      testCase(
        "a streamed turn reaches the same parts through the transport",
        dedent`
          const stream = ${
            shape.anthropic
              ? `streamOf(
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
          )`
              : `streamOf(
            { choices: [{ index: 0, delta: { content: "Hi" } }] },
            { choices: [{ index: 0, finish_reason: "stop", delta: {} }] },
          )`
          };
          const transport = answering(null, { sse: stream });
          const model = ${construct};

          const parts = await drain(model.stream({ messages: [userMessage("hi")] }));

          expect(parts[0]).toEqual({ type: "text-delta", text: "Hi" });
          expect(parts.at(-1)?.type).toBe("finish");
          // The body says it is a stream, which is where \`include_usage\` and the like are asked for.
          expect((transport.sent[0]?.body as Record<string, unknown>)["stream"]).toBe(true);
        `,
        true,
      ),
    ),
    when(
      shape.streaming,
      testCase(
        "a streamed response with no body to read is refused",
        dedent`
          const transport = answering(null);
          const model = ${construct};

          const refusal = await rejectionFrom(() =>
            drain(model.stream({ messages: [] })),
          );

          expect(refusal).toBeInstanceOf(MalformedResponseError);
        `,
        true,
      ),
    ),
    when(
      shape.streaming,
      testCase(
        "nothing is sent until the first part is asked for",
        dedent`
          const transport = answering(null, { sse: "" });
          const model = ${construct};

          const parts = model.stream({ messages: [] });
          // \`stream\` returns an iterable rather than a promise of one, and this is what that buys:
          // a caller can build the iterable and decide later whether to consume it.
          expect(transport.sent).toHaveLength(0);

          await drain(parts);
          expect(transport.sent).toHaveLength(1);
        `,
        true,
      ),
    ),
    dedent`
      function answeringAt(status: number): ${shape.streaming ? "StreamingChatModel" : "ChatModel"} {
        return ${names.factory}({
          modelId: "m",
          apiKey: "placeholder",
          fetch: answering({ error: "no" }, { status }).fetch,
        });
      }
    `,
  );
}
