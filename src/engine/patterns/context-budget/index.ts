/**
 * The `context-budget` pattern: making a conversation fit before it is sent.
 *
 * Four decisions, and the first is the whole reason the pattern is worth having.
 *
 * **The window holds the request and the reply together.** So the room for the answer comes off the top,
 * before anything is measured. A sliding window that measures messages against the whole window fits
 * every time and fails at the moment the model tries to reply, which reads as a provider problem rather
 * than an arithmetic one. The same goes for the two costs that are not messages: the system prompt (a
 * field on the request in this port, not a turn) and the tool schemas, which travel with every request.
 *
 * **A tool call and the results answering it are one unit.** Drop the assistant turn and keep the
 * results and every provider rejects the request, because a `callId` refers to nothing; keep the turn
 * and drop the results and it is rejected for the call nobody answered. Neither is visible to a caller
 * whose window arithmetic was correct, which is what makes it worth a rule rather than a note.
 *
 * **A turn that does not fit ends the search rather than being stepped over.** Packing the remaining
 * room with whatever still fits produces a conversation with a hole in it, which reads to the model as
 * though those turns never happened — a worse failure than one fewer turn, and a silent one.
 *
 * **A summary's room is reserved before the turns to summarise are chosen.** Discovered afterwards, the
 * request overflows by exactly the size of the summary that was supposed to save it. The summary is
 * folded into the system prompt rather than inserted as a message, because this port has no role a
 * summary belongs in: as a user turn it is something the user never said, and as an assistant turn it is
 * something the model never said.
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

const STEM = "context-budget";

export const contextBudgetPattern: PatternModule = {
  name: "context-budget",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const strategy =
      options.strategy === "summarise" || options.strategy === "middle-out"
        ? options.strategy
        : "drop-oldest";
    const shape: Shape = {
      strategy,
      summarising: strategy === "summarise",
      middleOut: strategy === "middle-out",
      toolPairing: options.toolPairing !== false,
      throwing: options.onOverflow === "throw",
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
  readonly strategy: "drop-oldest" | "summarise" | "middle-out";
  /** `strategy: "summarise"` — what was dropped comes back as prose in the system prompt. */
  readonly summarising: boolean;
  /** `strategy: "middle-out"` — the oldest turns are kept alongside the newest. */
  readonly middleOut: boolean;
  /** `toolPairing: true` — a tool call and its results are kept or dropped whole. */
  readonly toolPairing: boolean;
  /** `onOverflow: "throw"` — a conversation that cannot fit raises rather than returns. */
  readonly throwing: boolean;
}

/** The result type the entry point hands back: a union only when a refusal is one of its values. */
function resultType(shape: Shape): string {
  return shape.throwing ? "Fitted" : "Budgeted";
}

/** Everything `tokens` adds up, as a list that reads as a sentence in each shape. */
function costedParts(shape: Shape): string {
  const parts = [
    "the kept messages",
    shape.summarising
      ? "the system prompt with its summary"
      : "the system prompt",
    ...(shape.toolPairing ? ["the tool reserve"] : []),
  ];

  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

/** The strategy, as a sentence for a doc comment. */
function strategyProse(shape: Shape): string {
  switch (shape.strategy) {
    case "drop-oldest":
      return "The newest turns that fit, and nothing else.";
    case "summarise":
      return "The newest turns that fit, with everything older folded into a summary.";
    case "middle-out":
      return "The oldest turns and the newest, with the middle dropped.";
  }
}

// ---------------------------------------------------------------------------------------------------
// The core.
// ---------------------------------------------------------------------------------------------------

function core(shape: Shape): string {
  return sections(
    coreHeader(shape),
    messageTypes(shape),
    budgetType(shape),
    resultTypes(shape),
    entryPoint(shape),
    selection(shape),
    grouping(shape),
    costing(shape),
    estimating(),
    refusal(shape),
  );
}

function coreHeader(shape: Shape): string {
  return doc(
    "Fitting a conversation into a model's context window.",
    strategyProse(shape),
    "The arithmetic is the part worth reading. A context window holds the request and the reply together, so the room for the answer comes off before anything is measured — a conversation weighed against the whole window fits right up to the moment the model tries to answer. Two other costs are not messages and are as easy to forget: the system prompt, which this port sends as a field rather than a turn, and the tool schemas, which go with every request.",
    shape.toolPairing
      ? "Turns are kept and dropped in units, not one message at a time. An assistant turn that called a tool and the results answering it are one unit: separate them and the request is rejected, either for a `callId` that refers to nothing or for a call nobody answered."
      : "Each message is its own unit here. A conversation carrying tool results needs the pairing rule instead — dropping an assistant turn while keeping the results that answer it produces a request every provider rejects, and this file has no role to put those results in.",
    "Nothing here shortens a message. A truncated question is a different question, so a conversation whose undroppable part is larger than the window is refused rather than trimmed into one that fits.",
  );
}

function messageTypes(shape: Shape): string {
  return sections(
    doc(
      "The conversation, as the `chat-model-port` pattern's messages.",
      "Declared here rather than imported, so this file depends on nothing. It is the same shape, which the emitted type tests state as a claim in both directions: a conversation from the port can be measured, and what comes back can be sent.",
      "There is no `system` role, because the port has none — a system prompt is a field on the request. That is not a detail here: it makes the system prompt the one piece of context that cannot be dropped, so it is measured as a fixed cost rather than considered as a candidate.",
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
    when(
      shape.toolPairing,
      sections(
        documented(
          [
            "The model asking for a tool to be run.",
            "`input` is `unknown` because a tool declares a JSON Schema, which is a value rather than a type. What it costs is what it serialises to, which is all this file needs of it.",
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
            "`callId` is what pairs a result with the call it answers, and pairing is what the grouping below is for.",
          ],
          dedent`
            export interface ToolResultPart {
              readonly type: "tool-result";
              readonly callId: string;
              readonly toolName: string;
              readonly output: unknown;
            }
          `,
        ),
      ),
    ),
    documented(
      ["What the caller said."],
      dedent`
        export interface UserMessage {
          readonly role: "user";
          readonly content: readonly TextPart[];
        }
      `,
    ),
    documented(
      ["What the model said."],
      codeLines(
        "export interface AssistantMessage {",
        '  readonly role: "assistant";',
        shape.toolPairing
          ? "  readonly content: readonly (TextPart | ToolCallPart)[];"
          : "  readonly content: readonly TextPart[];",
        "}",
      ),
    ),
    when(
      shape.toolPairing,
      documented(
        [
          "What the tools produced.",
          "One of these can carry several results, and each one is a message of its own on the wire — which is why the framing charge below is counted per result rather than per message.",
        ],
        dedent`
          export interface ToolMessage {
            readonly role: "tool";
            readonly content: readonly ToolResultPart[];
          }
        `,
      ),
    ),
    codeLines(
      shape.toolPairing
        ? "export type Message = UserMessage | AssistantMessage | ToolMessage;"
        : "export type Message = UserMessage | AssistantMessage;",
    ),
  );
}

function budgetType(shape: Shape): string {
  return sections(
    doc(
      "What has to fit, and what it has to fit into.",
      "Every number is in tokens, and every one of them describes the same request: the window the provider allows, and the parts of that window this conversation does not get to use.",
    ),
    codeLines(
      "export interface Budget {",
      "  /** The provider's window for this model, request and reply together. */",
      "  readonly contextWindow: number;",
      "  /**",
      "   * Room to leave for the answer.",
      "   * Taken off the window before anything is measured. Left out, a conversation is fitted against room",
      "   * the reply needs, and the request is rejected on the way back rather than on the way out.",
      "   */",
      "  readonly reserveForOutput: number;",
      ...(shape.summarising
        ? [
            "  /**",
            "   * Room to leave for the summary, taken off before the turns to summarise are chosen.",
            "   * A summary written into room measured after the choice overflows the request by its own size.",
            "   * A summariser that comes back with more than this is refused rather than sent. Any number",
            "   * above zero also charges one message's framing, because the summary travels in the system",
            "   * field and a request with no system prompt has not paid for that field yet.",
            "   */",
            "  readonly reserveForSummary: number;",
            "  /**",
            "   * What the dropped turns become. Given every message that was dropped, in order.",
            "   * Usually another model call, which is why it may return a promise. It is called only when",
            "   * something was actually dropped, so a conversation that fits costs nothing.",
            "   */",
            "  readonly summarise: (dropped: readonly Message[]) => string | Promise<string>;",
          ]
        : []),
      ...(shape.middleOut
        ? [
            "  /**",
            "   * Room to spend on the oldest turns, out of what is left after the newest turn is pinned.",
            "   * There is no default worth having: zero makes this strategy the plain sliding window it was",
            "   * chosen over, and silently, so the number is asked for.",
            "   */",
            "  readonly reserveForHead: number;",
          ]
        : []),
      "  /**",
      "   * The system prompt, which is a field on a request rather than a message in it.",
      "   * Measured here so a caller cannot forget it, and charged one message's framing: one mainstream",
      "   * wire format sends it as the first message, and paying for framing it does not have is the",
      "   * harmless direction to be wrong in.",
      "   */",
      "  readonly system?: string;",
      ...(shape.toolPairing
        ? [
            "  /**",
            "   * What the tool schemas cost. They are sent with every request and are not messages.",
            "   * A number rather than the tools themselves, because what a schema costs depends on how the",
            "   * provider serialises it, which is the adapter's business and not this file's.",
            "   */",
            "  readonly reserveForTools?: number;",
          ]
        : []),
      "  /**",
      "   * What the provider adds around each message: the role, the delimiters, the turn markers.",
      "   * A per-provider fudge factor, and small — but a conversation of eighty short turns is mostly",
      "   * framing, so leaving it out is how a window that was measured carefully still overflows.",
      "   */",
      "  readonly perMessageOverhead?: number;",
      "  /**",
      "   * How to count tokens. The provider's own tokeniser, where there is one.",
      "   * The default is an estimate and is documented as one. Anything sized close to the window wants",
      "   * the real thing.",
      "   */",
      "  readonly countTokens?: (text: string) => number;",
      "}",
    ),
  );
}

function resultTypes(shape: Shape): string {
  return sections(
    documented(
      [
        "A conversation that fits, and what it cost.",
        ...(shape.summarising
          ? [
              "`system` is the prompt to send, with the summary folded in. It is here rather than in a field a caller has to remember to read, because a summary that is produced and then left behind is the one failure this strategy cannot report: the request is valid, in budget, and missing everything the model was told about the conversation so far.",
            ]
          : []),
      ],
      codeLines(
        "export interface Fitted {",
        ...(shape.throwing ? [] : ['  readonly kind: "fitted";']),
        "  /** The conversation to send, in order. */",
        "  readonly messages: readonly Message[];",
        "  /** What was left out, in order. Worth logging: it is the context the model will not have. */",
        "  readonly dropped: readonly Message[];",
        ...(shape.summarising
          ? [
              "  /** The system prompt to send, which is the caller's with the summary folded into it. */",
              "  readonly system: string;",
            ]
          : []),
        "  /**",
        `   * What the request will cost: ${costedParts(shape)}.`,
        "   * `tokens + reserveForOutput` never exceeds `contextWindow`, which is the invariant worth",
        "   * asserting in a caller's own suite.",
        "   */",
        "  readonly tokens: number;",
        "}",
      ),
    ),
    when(
      shape.throwing,
      documented(
        [
          "Raised when what cannot be dropped does not fit.",
          "Carries both numbers, because the only useful report of this names them: a caller who learns that a conversation was too long and not by how much has to reconstruct the arithmetic to do anything about it.",
        ],
        dedent`
          export class ContextOverflowError extends Error {
            readonly needed: number;
            readonly available: number;

            constructor(needed: number, available: number) {
              super(\`the conversation needs \${String(needed)} tokens and has \${String(available)}\`);
              this.name = "ContextOverflowError";
              this.needed = needed;
              this.available = available;
            }
          }
        `,
      ),
      sections(
        documented(
          [
            "What cannot be dropped does not fit.",
            "Both numbers are in the same currency, which is the input side of the window: `available` is the window less the room the reply was promised, and `needed` is what the request costs with every droppable turn already gone.",
          ],
          dedent`
            export interface Overflow {
              readonly kind: "overflow";
              readonly needed: number;
              readonly available: number;
            }
          `,
        ),
        documented(
          [
            "Either a conversation to send or the refusal to shorten a question.",
          ],
          "export type Budgeted = Fitted | Overflow;",
        ),
      ),
    ),
  );
}

function entryPoint(shape: Shape): string {
  // Kept as two pieces so that a room the summary has been taken out of still carries the head
  // allowance, rather than subtracting from it.
  const room = "available - fixed";
  const head = when(shape.middleOut, ", budget.reserveForHead");

  return sections(
    documented(
      [
        "Fits a conversation into a budget, or says that it cannot be done.",
        strategyProse(shape),
        shape.throwing
          ? "Raises `ContextOverflowError` when what cannot be dropped does not fit. Nothing is truncated to avoid that: a shortened question is a different question."
          : "Returns the `overflow` arm when what cannot be dropped does not fit. Nothing is truncated to avoid that: a shortened question is a different question.",
        shape.summarising
          ? "Send both halves of the result. The messages alone are in budget and missing what the summary was written to carry."
          : "",
      ],
      codeLines(
        shape.summarising
          ? "export async function fitToBudget("
          : "export function fitToBudget(",
        "  messages: readonly Message[],",
        "  budget: Budget,",
        shape.summarising
          ? `): Promise<${resultType(shape)}> {`
          : `): ${resultType(shape)} {`,
        "  const count = budget.countTokens ?? estimateTokens;",
        "  const overhead = budget.perMessageOverhead ?? MESSAGE_OVERHEAD;",
        BLANK,
        "  // The reply's room comes off first. A window holds both halves of the exchange, so a conversation",
        "  // measured against the whole of it fits until the moment the model tries to answer.",
        "  const available = budget.contextWindow - budget.reserveForOutput;",
        BLANK,
        "  // And these are charged before anything is chosen, because nothing below can drop them: the",
        "  // system prompt is a field rather than a turn" +
          (shape.toolPairing
            ? ", and the tool schemas are sent with every request."
            : "."),
        ...(shape.summarising
          ? [
              "  // The field's framing is charged whenever a summary has room to appear, because the summary",
              "  // travels in that same field. Charged afterwards instead, a conversation with no system prompt",
              "  // overflows by the framing of a field its own summary brought into being.",
              "  const framed =",
              "    budget.system !== undefined || budget.reserveForSummary > 0;",
              "  const fixed =",
              ...(shape.toolPairing
                ? ["    (budget.reserveForTools ?? 0) +"]
                : []),
              "    (framed ? overhead : 0) +",
              "    (budget.system === undefined ? 0 : count(budget.system));",
            ]
          : [
              "  const fixed =",
              ...(shape.toolPairing
                ? ["    (budget.reserveForTools ?? 0) +"]
                : []),
              "    (budget.system === undefined ? 0 : overhead + count(budget.system));",
            ]),
        BLANK,
        "  // Nothing is droppable at this point, so this is the answer rather than a special case of one.",
        "  if (fixed > available) {",
        "    return refused(fixed, available);",
        "  }",
        BLANK,
        "  const units = unitsOf(messages).map(",
        "    (unit): Unit => ({",
        "      messages: unit,",
        "      tokens: unit.reduce(",
        "        (total, message) => total + costOf(message, count, overhead),",
        "        0,",
        "      ),",
        "    }),",
        "  );",
        BLANK,
        `  const chosen = select(units, ${room}${head});`,
        BLANK,
        '  if (chosen.kind === "over") {',
        "    return refused(fixed + chosen.needed, available);",
        "  }",
        ...(shape.summarising
          ? [
              BLANK,
              "  // Nothing was dropped, so there is nothing to summarise and no reason to pay a model to say",
              "  // so. The reserve is left unspent rather than spent on an empty summary.",
              "  if (chosen.dropped.length === 0) {",
              "    return fitted(chosen, fixed, budget.system ?? \"\");",
              "  }",
              BLANK,
              "  // The summary's room comes out of the conversation's *before* the turns to summarise are",
              "  // chosen. Measured after, the request is over budget by the size of the summary that was",
              "  // supposed to bring it under.",
              `  const shorter = select(units, ${room} - budget.reserveForSummary${head});`,
              BLANK,
              '  if (shorter.kind === "over") {',
              "    return refused(",
              "      fixed + budget.reserveForSummary + shorter.needed,",
              "      available,",
              "    );",
              "  }",
              BLANK,
              "  const summary = await budget.summarise(shorter.dropped);",
              "  const written = count(summary);",
              BLANK,
              "  // A summariser that overran its room is refused rather than sent. The alternative is a request",
              "  // that overflows by however far it overran, which the provider reports and this file could not.",
              "  if (written > budget.reserveForSummary) {",
              "    return refused(fixed + written + shorter.tokens, available);",
              "  }",
              BLANK,
              "  return fitted(",
              "    shorter,",
              "    fixed + written,",
              "    withSummary(budget.system, summary),",
              "  );",
              "}",
            ]
          : [BLANK, "  return fitted(chosen, fixed);", "}"]),
      ),
    ),
    documented(
      [
        "The chosen turns, with the costs that are not turns added back in.",
      ],
      codeLines(
        "function fitted(",
        "  chosen: Chosen,",
        "  fixed: number,",
        ...(shape.summarising ? ["  system: string,"] : []),
        "): Fitted {",
        "  return {",
        ...(shape.throwing ? [] : ['    kind: "fitted",']),
        "    messages: chosen.messages,",
        "    dropped: chosen.dropped,",
        ...(shape.summarising ? ["    system,"] : []),
        "    tokens: fixed + chosen.tokens,",
        "  };",
        "}",
      ),
    ),
    when(
      shape.summarising,
      documented(
        [
          "The summary, in front of the prompt it belongs to.",
          "In the system prompt rather than in a message, because this port has no role for it: as a user turn it is something the user never said, and as an assistant turn it is something the model never said. One mainstream format sends the system prompt as the first message anyway, which is where a summary would have gone by hand.",
        ],
        dedent`
          function withSummary(system: string | undefined, summary: string): string {
            return system === undefined ? summary : \`\${system}\\n\\n\${summary}\`;
          }
        `,
      ),
    ),
  );
}

function selection(shape: Shape): string {
  return sections(
    doc("Choosing which turns to send."),
    documented(
      [
        shape.toolPairing
          ? "One unit of conversation, weighed. A turn, or a turn and the tool results answering it."
          : "One message, weighed.",
      ],
      dedent`
        interface Unit {
          readonly messages: readonly Message[];
          readonly tokens: number;
        }
      `,
    ),
    documented(
      [
        "The turns that fit, or the size of the ones that have to.",
        "`over` carries only what is needed, because the room it did not fit in is whatever the caller passed. Discriminated by a string rather than by a boolean: a boolean discriminant stops narrowing in a project with `strictNullChecks` off, which is one of the strictness settings this file is expected to compile under.",
      ],
      dedent`
        type Chosen = {
          readonly kind: "chosen";
          readonly messages: readonly Message[];
          readonly dropped: readonly Message[];
          readonly tokens: number;
        };

        type Selection = Chosen | { readonly kind: "over"; readonly needed: number };
      `,
    ),
    documented(
      [
        "Fills `room` with turns, newest first.",
        shape.middleOut
          ? "The oldest turns go in before the newest, up to `head` of the room, on the grounds that whatever the conversation is about was said at the beginning. What that leaves is a gap in the middle, which the model is not told about — the trade this strategy makes against summarising."
          : "",
        "The newest turn is pinned: it is the question, and a request without it asks nothing. Everything else is offered from the newest backwards and the search stops at the first turn that does not fit, rather than stepping over it to reach a smaller one behind it. A conversation with a hole in it reads as though those turns never happened, which is worse than one fewer turn and harder to notice.",
      ],
      codeLines(
        "function select(",
        "  units: readonly Unit[],",
        "  room: number,",
        ...(shape.middleOut ? ["  head: number,"] : []),
        "): Selection {",
        "  const newest = units.at(-1);",
        BLANK,
        "  if (newest === undefined) {",
        '    return { kind: "chosen", messages: [], dropped: [], tokens: 0 };',
        "  }",
        BLANK,
        "  if (newest.tokens > room) {",
        '    return { kind: "over", needed: newest.tokens };',
        "  }",
        BLANK,
        "  const keep = new Set<Unit>([newest]);",
        "  const older = units.slice(0, -1);",
        "  let left = room - newest.tokens;",
        ...(shape.middleOut
          ? [
              "  let headLeft = Math.min(head, left);",
              "  let taken = 0;",
              BLANK,
              "  for (const unit of older) {",
              "    if (unit.tokens > headLeft) break;",
              BLANK,
              "    keep.add(unit);",
              "    headLeft -= unit.tokens;",
              "    left -= unit.tokens;",
              "    taken += 1;",
              "  }",
              BLANK,
              "  for (const unit of [...older.slice(taken)].reverse()) {",
            ]
          : [BLANK, "  for (const unit of [...older].reverse()) {"]),
        "    if (unit.tokens > left) break;",
        BLANK,
        "    keep.add(unit);",
        "    left -= unit.tokens;",
        "  }",
        BLANK,
        "  // One mainstream format requires the first message to be the user's, and a window that opens",
        "  // part-way through an exchange reads oddly to any model. The newest unit is exempt: a tool loop",
        "  // asking for an answer to results it has just produced has nothing else to send.",
        "  for (const unit of units) {",
        "    if (!keep.has(unit)) continue;",
        "    if (unit === newest || beginsWithUser(unit)) break;",
        BLANK,
        "    keep.delete(unit);",
        "  }",
        BLANK,
        "  const kept = units.filter((unit) => keep.has(unit));",
        BLANK,
        "  return {",
        '    kind: "chosen",',
        "    messages: kept.flatMap((unit) => unit.messages),",
        "    dropped: units",
        "      .filter((unit) => !keep.has(unit))",
        "      .flatMap((unit) => unit.messages),",
        "    tokens: kept.reduce((total, unit) => total + unit.tokens, 0),",
        "  };",
        "}",
      ),
    ),
    documented(
      ["Whether a unit opens with the caller speaking."],
      dedent`
        function beginsWithUser(unit: Unit): boolean {
          return unit.messages.at(0)?.role === "user";
        }
      `,
    ),
  );
}

function grouping(shape: Shape): string {
  return when(
    shape.toolPairing,
    sections(
      documented(
        [
          "Groups the conversation into units that are kept or dropped whole.",
          "An assistant turn that asked for tools takes the results answering it with it. This is the rule a sliding window written a message at a time breaks, and it breaks it silently as far as the arithmetic is concerned: separate the two and the provider rejects the request, either for a `callId` that refers to nothing or for a call that nobody answered.",
          "A tool message that answers a call this unit did not make starts a unit of its own rather than being absorbed by whatever it happens to follow. Adjacency is not the relationship — the `callId` is — and gluing an unrelated result onto a turn would pin the wrong pair together.",
        ],
        dedent`
          function unitsOf(messages: readonly Message[]): readonly (readonly Message[])[] {
            const units: Message[][] = [];

            for (const message of messages) {
              const open = units.at(-1);

              if (message.role === "tool" && open !== undefined && answers(open, message)) {
                open.push(message);
                continue;
              }

              units.push([message]);
            }

            return units;
          }
        `,
      ),
      documented(
        [
          "Whether every result in `message` answers a call this unit made.",
          "Every, not some: a message carrying one result for this unit and one for another belongs to neither, and treating it as this unit's would take the other unit's result away with it.",
        ],
        dedent`
          function answers(unit: readonly Message[], message: ToolMessage): boolean {
            const calls = new Set(unit.flatMap(callIdsOf));

            return (
              message.content.length > 0 &&
              message.content.every((result) => calls.has(result.callId))
            );
          }
        `,
      ),
      documented(
        ["The calls a message asked for, which is none unless it is the model's."],
        dedent`
          function callIdsOf(message: Message): readonly string[] {
            return message.role === "assistant"
              ? message.content
                  .filter((part): part is ToolCallPart => part.type === "tool-call")
                  .map((part) => part.callId)
              : [];
          }
        `,
      ),
    ),
    documented(
      [
        "Groups the conversation into units that are kept or dropped whole.",
        "One message each, because without tool results there is nothing in a conversation that has to travel with something else. The shape is kept so that the pairing rule is a change to this function alone.",
      ],
      dedent`
        function unitsOf(messages: readonly Message[]): readonly (readonly Message[])[] {
          return messages.map((message) => [message]);
        }
      `,
    ),
  );
}

function costing(shape: Shape): string {
  return sections(
    doc("What a message costs."),
    documented(
      [
        "What one message costs: its framing, plus what its content serialises to.",
        ...(shape.toolPairing
          ? [
              "A tool message is charged one framing each per result rather than one for the message. This format keys a result to the call it answers, so a message carrying three results is three messages by the time it is on the wire, and charging it once understates it by two.",
            ]
          : []),
      ],
      codeLines(
        "function costOf(",
        "  message: Message,",
        "  count: (text: string) => number,",
        "  overhead: number,",
        "): number {",
        ...(shape.toolPairing
          ? [
              '  if (message.role === "tool") {',
              "    return message.content.reduce(",
              "      (total, result) =>",
              "        total + overhead + count(result.toolName) + count(jsonText(result.output)),",
              "      0,",
              "    );",
              "  }",
              BLANK,
              "  let total = overhead;",
              BLANK,
              "  // A loop rather than `reduce`, because `content` here is a union of two roles' array types",
              "  // and `reduce`'s overloads resolve differently in a project with `strict` off: the",
              "  // accumulator comes out as a message part and this file does not compile.",
              "  for (const part of message.content) {",
              "    total += count(textOf(part));",
              "  }",
              BLANK,
              "  return total;",
            ]
          : [
              "  return message.content.reduce(",
              "    (total, part) => total + count(part.text),",
              "    overhead,",
              "  );",
            ]),
        "}",
      ),
    ),
    when(
      shape.toolPairing,
      sections(
        documented(
          [
            "What a part of a turn costs text-wise.",
            "A tool call costs its name and its arguments, which is what the provider sends. Counting only the text parts of an assistant turn would report a turn that asked for three lookups as free.",
          ],
          dedent`
            function textOf(part: TextPart | ToolCallPart): string {
              return part.type === "text"
                ? part.text
                : \`\${part.toolName} \${jsonText(part.input)}\`;
            }
          `,
        ),
        documented(
          [
            "A tool's input or output as the text it will be sent as.",
            "These arrived as JSON and go back as JSON, so what they cost is what they serialise to.",
          ],
          dedent`
            function jsonText(value: unknown): string {
              // \`JSON.stringify(undefined)\` is \`undefined\` at run time, whatever the lib types promise.
              return JSON.stringify(value) ?? "";
            }
          `,
        ),
      ),
    ),
  );
}

function estimating(): string {
  return sections(
    documented(
      [
        "What the provider adds around each message, when a caller has not said.",
        "Small, and it is the kind of small that adds up: a conversation of eighty short turns is mostly framing. The real figure is in the provider's own documentation and is worth looking up.",
      ],
      "const MESSAGE_OVERHEAD = 4;",
    ),
    documented(
      [
        "Characters per token, for the default estimate.",
        "An English-prose figure. Code runs denser than prose, and a language written without spaces runs much denser — CJK text is close to one token per character, where this is out by a factor of four in the direction that fails.",
      ],
      "const CHARACTERS_PER_TOKEN = 4;",
    ),
    documented(
      [
        "Roughly how many tokens some text will cost.",
        "Rounded up, deliberately. An estimate that guesses low causes exactly the rejection this file exists to prevent, and one that guesses high costs a turn of context.",
        "It is an estimate, and for anything sized close to the window it is the wrong tool: pass the provider's own tokeniser as `countTokens` and this is never called.",
      ],
      dedent`
        export function estimateTokens(text: string): number {
          return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
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
      "A support chat that has outgrown its window.",
      "Two calls. The first has to lose turns and shows which ones; the second is a question that does not fit on its own, which is the case nothing can rescue.",
    ),
    importsFrom(context.conventions, spec, {
      values: [
        "fitToBudget",
        ...(shape.throwing ? ["ContextOverflowError"] : []),
      ],
      types: [
        "AssistantMessage",
        "Budget",
        "Message",
        ...(shape.toolPairing ? ["ToolMessage"] : []),
        "UserMessage",
      ],
    }),
    exampleFixtures(shape),
    exampleBudget(shape),
    exampleBody(shape),
    documented(
      ["Where the example's output goes."],
      dedent`
        function report(message: string): void {
          console.log(message);
        }
      `,
    ),
  );
}

function exampleFixtures(shape: Shape): string {
  return sections(
    doc("The conversation so far, and the two constructors it is written with."),
    codeLines(
      "function said(text: string): UserMessage {",
      '  return { role: "user", content: [{ type: "text", text }] };',
      "}",
      BLANK,
      "function replied(text: string): AssistantMessage {",
      '  return { role: "assistant", content: [{ type: "text", text }] };',
      "}",
      ...(shape.toolPairing
        ? [
            BLANK,
            "function lookedUp(callId: string, order: string): AssistantMessage {",
            "  return {",
            '    role: "assistant",',
            "    content: [",
            '      { type: "tool-call", callId, toolName: "findOrder", input: { order } },',
            "    ],",
            "  };",
            "}",
            BLANK,
            "function found(callId: string, status: string): ToolMessage {",
            "  return {",
            '    role: "tool",',
            "    content: [",
            "      {",
            '        type: "tool-result",',
            "        callId,",
            '        toolName: "findOrder",',
            "        output: { status },",
            "      },",
            "    ],",
            "  };",
            "}",
          ]
        : []),
    ),
    documented(
      [
        shape.toolPairing
          ? "Eight messages, one of which is a lookup and its answer — a pair that has to travel together."
          : "Six messages, oldest first.",
      ],
      codeLines(
        "const CHAT: readonly Message[] = [",
        '  said("hello, I am chasing an order from last week"),',
        '  replied("happy to help. do you have the order number?"),',
        '  said("it is A-1041, placed on the tuesday"),',
        ...(shape.toolPairing
          ? [
              '  lookedUp("call-1", "A-1041"),',
              '  found("call-1", "shipped on wednesday, arriving friday"),',
            ]
          : []),
        '  replied("that one shipped on wednesday and is due friday"),',
        '  said("is there a tracking number for it?"),',
        '  replied("there is: TRK-88213, on the courier\'s site"),',
        '  said("and can I change the delivery address now?"),',
        "];",
      ),
    ),
    documented(
      ["Long enough that no window in this file could hold it."],
      'const LOG = "GET /orders/A-1041 200 OK\\n".repeat(40);',
    ),
  );
}

function exampleBudget(shape: Shape): string {
  return documented(
    [
      "The window this model has, and everything in it that the conversation does not get.",
      "No `countTokens`, so the default estimate is used — fine for an example and not for a request sized close to the edge, where the provider's own tokeniser is the only honest answer.",
    ],
    codeLines(
      "const BUDGET: Budget = {",
      "  contextWindow: 160,",
      "  reserveForOutput: 60,",
      '  system: "You are a support agent. Be brief and never guess an order status.",',
      ...(shape.toolPairing ? ["  reserveForTools: 30,"] : []),
      ...(shape.middleOut ? ["  reserveForHead: 20,"] : []),
      ...(shape.summarising
        ? [
            "  reserveForSummary: 24,",
            "  // Normally a call to a cheap model. Kept as a function here so the example has no network in",
            "  // it, and it is worth noticing that it must come back inside the room reserved above.",
            "  summarise: (dropped: readonly Message[]): string =>",
            "    `Earlier: ${String(dropped.length)} turns about order A-1041.`,",
          ]
        : []),
      "};",
    ),
  );
}

function exampleBody(shape: Shape): string {
  const call = shape.summarising
    ? "await fitToBudget(CHAT, BUDGET)"
    : "fitToBudget(CHAT, BUDGET)";

  return documented(
    [
      "Fitting the chat, then failing to fit a question.",
      shape.summarising
        ? "Both halves of the result are sent: the messages alone are in budget and have lost everything the summary was written to carry."
        : "",
    ],
    codeLines(
      shape.summarising
        ? "export async function main(): Promise<void> {"
        : "export function main(): void {",
      ...(shape.throwing
        ? [`  const fitted = ${call};`]
        : [
            `  const fitted = ${call};`,
            BLANK,
            '  if (fitted.kind === "overflow") {',
            "    report(",
            "      `the chat needs ${String(fitted.needed)} tokens and has ${String(fitted.available)}`,",
            "    );",
            BLANK,
            "    return;",
            "  }",
          ]),
      BLANK,
      "  report(",
      "    `kept ${String(fitted.messages.length)} of ${String(CHAT.length)} messages ` +",
      "      `for ${String(fitted.tokens)} tokens, dropping ${String(fitted.dropped.length)}`,",
      "  );",
      ...(shape.summarising
        ? [BLANK, "  report(`the prompt to send is now: ${fitted.system}`);"]
        : []),
      BLANK,
      "  // The other case: a question that does not fit on its own. Nothing can be dropped to make room",
      "  // for it, and shortening it would answer a question nobody asked.",
      "  const essay = [said(`here is the whole log: ${LOG}`)];",
      ...(shape.throwing
        ? [
            BLANK,
            "  try {",
            `    ${shape.summarising ? "await " : ""}fitToBudget(essay, BUDGET);`,
            "  } catch (failure) {",
            "    if (!(failure instanceof ContextOverflowError)) throw failure;",
            BLANK,
            "    report(",
            "      `refused: it needs ${String(failure.needed)} tokens and has ${String(failure.available)}`,",
            "    );",
            "  }",
            "}",
          ]
        : [
            BLANK,
            `  const refused = ${shape.summarising ? "await " : ""}fitToBudget(essay, BUDGET);`,
            BLANK,
            '  if (refused.kind === "overflow") {',
            "    report(",
            "      `refused: it needs ${String(refused.needed)} tokens and has ${String(refused.available)}`,",
            "    );",
            "  }",
            "}",
          ]),
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The type-level suite.
// ---------------------------------------------------------------------------------------------------

function typeTests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;

  return sections(
    doc(
      "The claims about this file's conversation that no suite which runs could check.",
      "Two of them are about fitting into the `chat-model-port` pattern, which is where a conversation comes from and where the fitted one goes. A file that had drifted out of shape with the port would behave identically here and fail at the call site, so the port's messages are declared below and compared rather than described in a comment.",
    ),
    importsFrom(conventions, siblingSpecifier(conventions, STEM), {
      values: [],
      // Each of the three is named only where a claim below mentions it. Most of this file is about a
      // message and about what fitting returns, so the budget is an argument to the call rather than part
      // of either — except under the two strategies that require a field of their own, where the refusal
      // to omit it is the claim and has to be written as a budget. Imported unconditionally, it was a
      // type nothing asked about under every other strategy.
      types: [
        ...(shape.summarising || shape.middleOut ? ["Budget"] : []),
        ...(shape.throwing ? [] : ["Budgeted"]),
        "Message",
      ],
    }),
    typeAssertKit(
      shape.toolPairing ? ["Extends"] : ["Extends", "NotAssignable"],
    ),
    documented(
      [
        "The port's conversation, written out so that the comparison is a claim and not a hope.",
        "`failed` is on the port's result and not on this file's, which is why these are compared by assignability rather than by identity: a file that measures messages needs the fields that cost something and no others.",
      ],
      dedent`
        interface PortText {
          readonly type: "text";
          readonly text: string;
        }

        interface PortCall {
          readonly type: "tool-call";
          readonly callId: string;
          readonly toolName: string;
          readonly input: unknown;
        }

        interface PortResult {
          readonly type: "tool-result";
          readonly callId: string;
          readonly toolName: string;
          readonly output: unknown;
          readonly failed?: boolean;
        }

        type PortMessage =
          | { readonly role: "user"; readonly content: readonly PortText[] }
          | { readonly role: "assistant"; readonly content: readonly (PortText | PortCall)[] }
          | { readonly role: "tool"; readonly content: readonly PortResult[] };
      `,
    ),
    documented(
      ["What comes back can be sent: the fitted conversation is the port's."],
      "export type FittedIsSendable = Expect<\n  Extends<readonly Message[], readonly PortMessage[]>\n>;",
    ),
    shape.toolPairing
      ? documented(
          [
            "And a conversation from the port can be measured, tool results included.",
          ],
          "export type PortIsMeasurable = Expect<\n  Extends<readonly PortMessage[], readonly Message[]>\n>;",
        )
      : documented(
          [
            "The port's conversation is refused, which is what turning the pairing rule off means.",
            "Not a shortcoming: without the rule this file cannot promise that a tool call and its results stay together, so it declines to be given any. Stated as a relationship rather than with a directive, which would be satisfied by any error on the line.",
          ],
          "export type PortIsRefused = Expect<\n  NotAssignable<readonly PortMessage[], readonly Message[]>\n>;",
        ),
    when(
      !shape.throwing,
      documented(
        [
          "A refusal carries no conversation, so a caller cannot send one without looking first.",
          "The point of the union rather than an empty message list: an unchecked result whose messages are `[]` sends a request with no conversation in it, which most providers answer.",
        ],
        codeLines(
          "export function overflowHasNoMessages(result: Budgeted): number {",
          "  // @ts-expect-error the overflow arm has no messages on it",
          "  return result.messages.length;",
          "}",
        ),
      ),
    ),
    when(
      shape.summarising || shape.middleOut,
      documented(
        [
          shape.summarising
            ? "A budget with no summariser is refused, rather than being one that drops the turns instead."
            : "A budget with no allowance for the oldest turns is refused, rather than being one that quietly behaves as the plain sliding window this strategy was chosen over.",
          "The field has no default for that reason. What a default would buy is a budget that compiles and does something other than what the strategy is for.",
        ],
        codeLines(
          "export function theStrategyNeedsItsOwnFields(): Budget {",
          shape.summarising
            ? "  // @ts-expect-error a summarising budget has to say what to summarise with"
            : "  // @ts-expect-error this strategy has to say what the oldest turns may spend",
          "  return {",
          "    contextWindow: 8192,",
          "    reserveForOutput: 1024,",
          ...(shape.summarising ? ["    reserveForSummary: 256,"] : []),
          "  };",
          "}",
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------------------------------

/** `await`, only where the entry point returns a promise. */
function awaited(shape: Shape): string {
  return shape.summarising ? "await " : "";
}

/** An `it(...)` whose body is async only where the entry point returns a promise. */
function opens(shape: Shape, name: string): string {
  return `  it("${name}", ${shape.summarising ? "async " : ""}() => {`;
}

function tests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;

  return sections(
    doc(
      "The arithmetic, exactly.",
      "Every case counts one token per character and turns the framing charge off, so the numbers here are arithmetic rather than approximation — which is the only way to tell a budget that forgot the reply's room from one that did not, since both fit.",
      "What is being pinned is mostly what a conversation loses. A window that measures against the whole of itself is right until the model answers; a turn stepped over leaves a hole nothing reports; a summary measured after the choice overflows by its own size. None of those announce themselves at the call site.",
    ),
    frameworkImports(conventions),
    importsFrom(conventions, siblingSpecifier(conventions, STEM), {
      values: [
        ...(shape.throwing ? ["ContextOverflowError"] : []),
        "estimateTokens",
        "fitToBudget",
      ],
      types: [
        "AssistantMessage",
        "Budget",
        "Fitted",
        "Message",
        ...(shape.throwing ? [] : ["Overflow"]),
        ...(shape.toolPairing ? ["TextPart", "ToolCallPart", "ToolMessage"] : []),
        "UserMessage",
      ],
    }),
    testFixtures(shape),
    arithmeticCases(shape),
    choiceCases(shape),
    when(shape.toolPairing, pairingCases(shape)),
    overflowCases(shape),
    when(shape.summarising, summaryCases(shape)),
    when(shape.middleOut, middleOutCases(shape)),
    estimateCases(shape),
  );
}

function testFixtures(shape: Shape): string {
  const extras = [
    ...(shape.summarising
      ? ['  reserveForSummary: 0,', '  summarise: (): string => "",']
      : []),
    ...(shape.middleOut ? ["  reserveForHead: 0,"] : []),
  ];

  return sections(
    doc("A conversation, a budget that charges only what a case asks it to, and two ways to read a result."),
    documented(
      [
        "One token per character.",
        "An exact counter rather than the estimate, so that a case can say what a conversation costs instead of roughly what it costs. Real ones are the provider's, and are not this simple.",
      ],
      dedent`
        function perCharacter(text: string): number {
          return text.length;
        }
      `,
    ),
    documented(
      [
        "A budget with every default turned off, which each case adds to.",
        "The framing charge is zero here so that the numbers below are the messages and nothing else. A real budget leaves it on: turning it off is how a conversation of many short turns comes out a third under its true size.",
      ],
      codeLines(
        "const EXACT: Budget = {",
        "  contextWindow: 100,",
        "  reserveForOutput: 0,",
        ...extras,
        "  perMessageOverhead: 0,",
        "  countTokens: perCharacter,",
        "};",
      ),
    ),
    documented(
      [
        "The same budget with the defaults left in: the estimate and the framing charge.",
      ],
      codeLines(
        "const ESTIMATED: Budget = {",
        "  contextWindow: 100,",
        "  reserveForOutput: 0,",
        ...extras,
        "};",
      ),
    ),
    documented(
      ["The turns a case is written from."],
      codeLines(
        "function said(text: string): UserMessage {",
        '  return { role: "user", content: [{ type: "text", text }] };',
        "}",
        BLANK,
        "function replied(text: string): AssistantMessage {",
        '  return { role: "assistant", content: [{ type: "text", text }] };',
        "}",
        ...(shape.toolPairing
          ? [
              BLANK,
              "function called(...callIds: readonly string[]): AssistantMessage {",
              "  return {",
              '    role: "assistant",',
              "    content: callIds.map((callId) => ({",
              '      type: "tool-call" as const,',
              "      callId,",
              '      toolName: "t",',
              "      input: 1,",
              "    })),",
              "  };",
              "}",
              BLANK,
              "function answered(...callIds: readonly string[]): ToolMessage {",
              "  return {",
              '    role: "tool",',
              "    content: callIds.map((callId) => ({",
              '      type: "tool-result" as const,',
              "      callId,",
              '      toolName: "t",',
              "      output: 1,",
              "    })),",
              "  };",
              "}",
            ]
          : []),
      ),
    ),
    documented(
      [
        "Five turns of four tokens each, which is the conversation most cases below are cut from.",
      ],
      codeLines(
        "const CHAT: readonly Message[] = [",
        '  said("aaaa"),',
        '  replied("bbbb"),',
        '  said("cccc"),',
        '  replied("dddd"),',
        '  said("eeee"),',
        "];",
      ),
    ),
    documented(
      [
        "Each message as a short label, so a case can name the turns that survived in one assertion.",
      ],
      codeLines(
        "function labelsOf(messages: readonly Message[]): readonly string[] {",
        "  return messages.map(labelOf);",
        "}",
        BLANK,
        "function labelOf(message: Message): string {",
        ...(shape.toolPairing
          ? [
              '  if (message.role === "tool") {',
              '    return `tool:${message.content.map((result) => result.callId).join(",")}`;',
              "  }",
              BLANK,
              "  // Widened before it is walked: the two remaining roles have different content types, and a",
              "  // method called on the union of two array types is not callable.",
              "  const parts: readonly (TextPart | ToolCallPart)[] = message.content;",
              BLANK,
              "  return parts",
              '    .map((part) => (part.type === "text" ? part.text : `call:${part.callId}`))',
              '    .join(" ");',
            ]
          : ['  return message.content.map((part) => part.text).join(" ");']),
        "}",
      ),
    ),
    documented(
      [
        "The conversation that fitted, or a failure naming what came back instead.",
        shape.throwing
          ? "A refusal arrives as an exception here, so this is only the call — and every case below reads as though a fit were the only possibility, which for most of them it is."
          : "Every case below is about the arithmetic rather than about unwrapping a union, so the unwrapping happens once, here.",
      ],
      codeLines(
        shape.summarising
          ? "async function fit("
          : "function fit(",
        "  messages: readonly Message[],",
        "  budget: Budget,",
        shape.summarising ? "): Promise<Fitted> {" : "): Fitted {",
        ...(shape.throwing
          ? [`  return ${awaited(shape)}fitToBudget(messages, budget);`]
          : [
              `  const result = ${awaited(shape)}fitToBudget(messages, budget);`,
              BLANK,
              '  if (result.kind === "overflow") {',
              "    throw new Error(",
              "      `expected a fit, got an overflow needing ${String(result.needed)}`,",
              "    );",
              "  }",
              BLANK,
              "  return result;",
            ]),
        "}",
      ),
    ),
    documented(
      [
        "And the refusal, however this file reports one.",
        shape.throwing
          ? "The two numbers are on the error rather than in its message, so that a caller can report the shortfall without parsing prose. That is what this reads."
          : "",
      ],
      codeLines(
        shape.summarising
          ? "async function refusalOf("
          : "function refusalOf(",
        "  messages: readonly Message[],",
        "  budget: Budget,",
        ...(shape.throwing
          ? [
              shape.summarising
                ? "): Promise<ContextOverflowError> {"
                : "): ContextOverflowError {",
              "  try {",
              `    ${awaited(shape)}fitToBudget(messages, budget);`,
              "  } catch (failure) {",
              "    if (failure instanceof ContextOverflowError) return failure;",
              BLANK,
              "    throw failure;",
              "  }",
              BLANK,
              '  throw new Error("expected an overflow, got a fit");',
            ]
          : [
              shape.summarising ? "): Promise<Overflow> {" : "): Overflow {",
              `  const result = ${awaited(shape)}fitToBudget(messages, budget);`,
              BLANK,
              '  if (result.kind !== "overflow") {',
              "    throw new Error(",
              "      `expected an overflow, got a fit costing ${String(result.tokens)}`,",
              "    );",
              "  }",
              BLANK,
              "  return result;",
            ]),
        "}",
      ),
    ),
  );
}

function arithmeticCases(shape: Shape): string {
  const fit = `${awaited(shape)}fit`;

  return codeLines(
    'describe("the arithmetic", () => {',
    opens(shape, "keeps everything when everything fits"),
    `    const fitted = ${fit}(CHAT, EXACT);`,
    BLANK,
    '    expect(labelsOf(fitted.messages)).toEqual(["aaaa", "bbbb", "cccc", "dddd", "eeee"]);',
    "    expect(fitted.dropped).toHaveLength(0);",
    "    expect(fitted.tokens).toBe(20);",
    "  });",
    BLANK,
    opens(shape, "takes the reply's room out of the window before measuring"),
    `    const roomy = ${fit}(CHAT, { ...EXACT, contextWindow: 20 });`,
    `    const cramped = ${fit}(CHAT, {`,
    "      ...EXACT,",
    "      contextWindow: 20,",
    "      reserveForOutput: 16,",
    "    });",
    BLANK,
    "    // The same conversation against the same window. All that changed is what was promised to the",
    "    // answer, and a budget that leaves it out fits until the model tries to use it.",
    "    expect(roomy.messages).toHaveLength(5);",
    '    expect(labelsOf(cramped.messages)).toEqual(["eeee"]);',
    "  });",
    BLANK,
    opens(shape, "counts the system prompt, which is a field rather than a turn"),
    `    const bare = ${fit}(CHAT, { ...EXACT, contextWindow: 20 });`,
    `    const prompted = ${fit}(CHAT, {`,
    "      ...EXACT,",
    "      contextWindow: 20,",
    '      system: "ssssssssssssssss",',
    "    });",
    BLANK,
    "    expect(bare.messages).toHaveLength(5);",
    '    expect(labelsOf(prompted.messages)).toEqual(["eeee"]);',
    "    expect(prompted.tokens).toBe(20);",
    "  });",
    ...(shape.toolPairing
      ? [
          BLANK,
          opens(shape, "counts the tool schemas, which travel with every request"),
          `    const untooled = ${fit}(CHAT, { ...EXACT, contextWindow: 20 });`,
          `    const tooled = ${fit}(CHAT, {`,
          "      ...EXACT,",
          "      contextWindow: 20,",
          "      reserveForTools: 16,",
          "    });",
          BLANK,
          "    expect(untooled.messages).toHaveLength(5);",
          '    expect(labelsOf(tooled.messages)).toEqual(["eeee"]);',
          "  });",
        ]
      : []),
    BLANK,
    opens(shape, "charges the system prompt one message's framing too"),
    `    const framed = ${fit}([said("aaaa")], {`,
    "      ...EXACT,",
    "      perMessageOverhead: 3,",
    '      system: "ssss",',
    "    });",
    BLANK,
    "    // Two lots of framing for one turn and one prompt. The prompt is a field rather than a message,",
    "    // but one mainstream format puts it on the wire as the first message, and paying for framing it",
    "    // may not have is the harmless direction to be wrong in.",
    "    expect(framed.tokens).toBe(14);",
    "  });",
    BLANK,
    opens(shape, "charges the framing the provider puts around each message"),
    `    const bare = ${fit}(CHAT, EXACT);`,
    `    const framed = ${fit}(CHAT, { ...EXACT, perMessageOverhead: 10 });`,
    BLANK,
    "    expect(bare.tokens).toBe(20);",
    "    expect(framed.tokens).toBe(70);",
    "  });",
    BLANK,
    opens(shape, "reports a total the reply still fits beside"),
    "    const budget: Budget = {",
    "      ...EXACT,",
    "      contextWindow: 32,",
    "      reserveForOutput: 8,",
    '      system: "ssss",',
    "    };",
    `    const fitted = ${fit}(CHAT, budget);`,
    BLANK,
    "    // 24 of the window is the input's, and the whole conversation and the prompt come to exactly",
    "    // that. `tokens + reserveForOutput === contextWindow` is the invariant worth asserting in a",
    "    // caller's own suite, and this is the edge of it.",
    "    expect(fitted.messages).toHaveLength(5);",
    "    expect(fitted.tokens).toBe(24);",
    "  });",
    "});",
  );
}

function choiceCases(shape: Shape): string {
  const fit = `${awaited(shape)}fit`;

  return codeLines(
    'describe("choosing which turns to send", () => {',
    opens(shape, "keeps the newest turns and drops the oldest"),
    `    const fitted = ${fit}(CHAT, { ...EXACT, contextWindow: 12 });`,
    BLANK,
    '    expect(labelsOf(fitted.messages)).toEqual(["cccc", "dddd", "eeee"]);',
    '    expect(labelsOf(fitted.dropped)).toEqual(["aaaa", "bbbb"]);',
    "  });",
    BLANK,
    opens(shape, "stops at a turn that does not fit instead of stepping over it"),
    "    const chat = [said(\"aa\"), replied(\"d\".repeat(40)), said(\"bb\")];",
    `    const fitted = ${fit}(chat, { ...EXACT, contextWindow: 10 });`,
    BLANK,
    '    // "aa" would have fitted in what was left. Taking it would send two turns that read as',
    "    // consecutive with forty tokens of exchange missing between them, which is a worse answer than",
    "    // one turn fewer and a quieter one.",
    '    expect(labelsOf(fitted.messages)).toEqual(["bb"]);',
    "    expect(fitted.dropped).toHaveLength(2);",
    "  });",
    BLANK,
    opens(shape, "does not open the window with the model speaking"),
    '    const chat = [said("aaaa"), replied("bb"), said("cc")];',
    `    const fitted = ${fit}(chat, { ...EXACT, contextWindow: 6 });`,
    BLANK,
    "    // There was room for the model's turn, and it goes anyway: one mainstream format rejects a",
    "    // conversation that opens with an answer to a question it cannot see.",
    '    expect(labelsOf(fitted.messages)).toEqual(["cc"]);',
    '    expect(labelsOf(fitted.dropped)).toEqual(["aaaa", "bb"]);',
    "  });",
    BLANK,
    opens(shape, "sends the newest turn even when it is not the caller's"),
    `    const fitted = ${fit}([replied("aaaa")], EXACT);`,
    BLANK,
    "    // The exemption to the rule above. A loop asking for an answer to what it has just produced has",
    "    // nothing else to send, and trimming this would leave a request with no conversation in it.",
    '    expect(labelsOf(fitted.messages)).toEqual(["aaaa"]);',
    "  });",
    BLANK,
    opens(shape, "fits an empty conversation"),
    `    const fitted = ${fit}([], EXACT);`,
    BLANK,
    "    expect(fitted.messages).toHaveLength(0);",
    "    expect(fitted.tokens).toBe(0);",
    "  });",
    "});",
  );
}

function pairingCases(shape: Shape): string {
  const fit = `${awaited(shape)}fit`;

  return codeLines(
    'describe("a tool call and the results answering it", () => {',
    opens(shape, "keeps them together"),
    '    const chat = [said("aaaa"), called("c1"), answered("c1"), said("bb")];',
    `    const fitted = ${fit}(chat, { ...EXACT, contextWindow: 11 });`,
    BLANK,
    '    expect(labelsOf(fitted.messages)).toEqual(["aaaa", "call:c1", "tool:c1", "bb"]);',
    "  });",
    BLANK,
    opens(shape, "refuses rather than sending a result whose call did not fit"),
    `    const refusal = ${awaited(shape)}refusalOf([called("c1"), answered("c1")], {`,
    "      ...EXACT,",
    "      contextWindow: 3,",
    "    });",
    BLANK,
    "    // Three tokens is enough for the result on its own, and a result whose call is missing is",
    "    // rejected by every provider for a `callId` that refers to nothing. The pair is one unit, so",
    "    // what would have been an unexplained 400 is a refusal that names the shortfall.",
    "    expect(refusal.needed).toBe(5);",
    "    expect(refusal.available).toBe(3);",
    "  });",
    BLANK,
    opens(shape, "groups by the call a result answers, not by what it follows"),
    "    const budget: Budget = { ...EXACT, contextWindow: 3 };",
    `    const unrelated = ${fit}([called("c1"), answered("c9")], budget);`,
    BLANK,
    "    // Adjacency is not the relationship. This result answers a call nobody made, so it is a unit of",
    "    // its own and can be sent without one — where a result that did answer the call above it could",
    "    // not, which is the case before this one.",
    '    expect(labelsOf(unrelated.messages)).toEqual(["tool:c9"]);',
    "  });",
    BLANK,
    opens(shape, "keeps a message that only half answers the turn above it apart from it"),
    `    const half = ${fit}([called("c1"), answered("c1", "c9")], {`,
    "      ...EXACT,",
    "      contextWindow: 4,",
    "    });",
    BLANK,
    "    // One of these two results answers the call above and one answers a call nobody made, so the",
    "    // message belongs to neither turn. Absorbed into the turn above, the pair would be inseparable",
    "    // and this request would no longer fit — and the unrelated result would be pinned to a turn that",
    "    // has nothing to do with it.",
    "    expect(half.messages).toHaveLength(1);",
    "    expect(half.dropped).toHaveLength(1);",
    "  });",
    BLANK,
    opens(shape, "charges one framing per result, because that is what goes on the wire"),
    '    const chat = [called("c1", "c2", "c3"), answered("c1", "c2", "c3")];',
    `    const fitted = ${fit}(chat, { ...EXACT, perMessageOverhead: 10 });`,
    BLANK,
    "    // The turn asking is one message: ten of framing and three calls at three characters each. The",
    "    // results are three messages by the time they are sent, so they are framed three times over.",
    "    expect(fitted.tokens).toBe(19 + 36);",
    "  });",
    BLANK,
    opens(shape, "counts what a call serialises to"),
    `    const fitted = ${fit}([called("c1")], EXACT);`,
    BLANK,
    "    // The tool's name and its arguments, which is what the provider is sent. Counting only the text",
    "    // parts of a turn would report one that asked for three lookups as free.",
    "    expect(fitted.tokens).toBe(3);",
    "  });",
    "});",
  );
}

function overflowCases(shape: Shape): string {
  return codeLines(
    'describe("what cannot be made to fit", () => {',
    opens(shape, "refuses a question larger than the window"),
    `    const refusal = ${awaited(shape)}refusalOf([said("a".repeat(50))], {`,
    "      ...EXACT,",
    "      contextWindow: 20,",
    "    });",
    BLANK,
    "    // Not truncated to fit. A shortened question is a different question, and an answer to it is",
    "    // worse than a refusal because it looks like an answer.",
    "    expect(refusal.needed).toBe(50);",
    "    expect(refusal.available).toBe(20);",
    "  });",
    BLANK,
    opens(shape, "counts the promise to the answer in what there was room for"),
    `    const refusal = ${awaited(shape)}refusalOf([said("a".repeat(50))], {`,
    "      ...EXACT,",
    "      contextWindow: 20,",
    "      reserveForOutput: 5,",
    "    });",
    BLANK,
    "    expect(refusal.available).toBe(15);",
    "  });",
    BLANK,
    opens(shape, "counts the system prompt in what was needed"),
    `    const refusal = ${awaited(shape)}refusalOf([said("a".repeat(50))], {`,
    "      ...EXACT,",
    "      contextWindow: 20,",
    '      system: "ssss",',
    "    });",
    BLANK,
    "    // The prompt cannot be dropped either, so the smallest this request could become is both of them.",
    "    expect(refusal.needed).toBe(54);",
    "  });",
    BLANK,
    opens(shape, "refuses a system prompt larger than the window on its own"),
    `    const refusal = ${awaited(shape)}refusalOf([], {`,
    "      ...EXACT,",
    "      contextWindow: 4,",
    '      system: "ssssssss",',
    "    });",
    BLANK,
    "    // Nothing is droppable here, so there is no conversation to shorten and no arithmetic to do.",
    "    expect(refusal.needed).toBe(8);",
    "    expect(refusal.available).toBe(4);",
    "  });",
    "});",
  );
}

function summaryCases(shape: Shape): string {
  const fit = `${awaited(shape)}fit`;

  return codeLines(
    'describe("the summary", () => {',
    opens(shape, "is given exactly what was dropped, once"),
    "    let seen: readonly Message[] | undefined;",
    "    let calls = 0;",
    `    const fitted = ${fit}(CHAT, {`,
    "      ...EXACT,",
    "      contextWindow: 12,",
    "      // Enough room reserved that the summary costs the conversation a turn, so what was dropped",
    "      // for the summary to describe is not what would have been dropped without it.",
    "      reserveForSummary: 4,",
    "      summarise: (dropped: readonly Message[]): string => {",
    "        seen = dropped;",
    "        calls += 1;",
    BLANK,
    '        return "";',
    "      },",
    "    });",
    BLANK,
    "    expect(calls).toBe(1);",
    "    expect(labelsOf(seen ?? [])).toEqual(labelsOf(fitted.dropped));",
    "  });",
    BLANK,
    opens(shape, "is not written when nothing was dropped"),
    "    let calls = 0;",
    `    const fitted = ${fit}([said("aa")], {`,
    "      ...EXACT,",
    "      summarise: (): string => {",
    "        calls += 1;",
    BLANK,
    '        return "a summary of nothing";',
    "      },",
    "    });",
    BLANK,
    "    // A conversation that fits costs nothing, which is worth more than it sounds: a summariser is",
    "    // usually another model call, and one per request that did not need it is a bill.",
    "    expect(calls).toBe(0);",
    '    expect(fitted.system).toBe("");',
    "  });",
    BLANK,
    opens(shape, "has its room taken out before the turns are chosen"),
    "    const budget: Budget = {",
    "      ...EXACT,",
    "      contextWindow: 14,",
    '      summarise: (): string => "ss",',
    "    };",
    `    const generous = ${fit}(CHAT, { ...budget, reserveForSummary: 2 });`,
    `    const stingy = ${fit}(CHAT, { ...budget, reserveForSummary: 6 });`,
    BLANK,
    '    expect(labelsOf(generous.messages)).toEqual(["cccc", "dddd", "eeee"]);',
    BLANK,
    "    // Four more tokens promised to the summary, and a turn comes out of the conversation to pay for",
    "    // it. Reserved after the choice instead, the request would be over budget by the size of the",
    "    // summary that was meant to bring it under.",
    '    expect(labelsOf(stingy.messages)).toEqual(["eeee"]);',
    "  });",
    BLANK,
    opens(shape, "goes in front of the caller's prompt"),
    `    const fitted = ${fit}(CHAT, {`,
    "      ...EXACT,",
    "      contextWindow: 20,",
    '      system: "be brief",',
    "      reserveForSummary: 4,",
    '      summarise: (): string => "gist",',
    "    });",
    BLANK,
    '    expect(fitted.system).toBe("be brief\\n\\ngist");',
    BLANK,
    "    // And it is paid for: the prompt, the summary and the one turn that was left room.",
    "    expect(fitted.tokens).toBe(16);",
    "  });",
    BLANK,
    opens(shape, "pays for the field it puts itself in"),
    "    // Three turns from one speaker, so what is chosen below is decided by the arithmetic rather",
    "    // than by which speaker the window happens to open on.",
    '    const asked = [said("aaaa"), said("bbbb"), said("cccc")];',
    `    const fitted = ${fit}(asked, {`,
    "      ...EXACT,",
    "      contextWindow: 12,",
    "      perMessageOverhead: 1,",
    "      reserveForSummary: 2,",
    '      summarise: (): string => "ss",',
    "    });",
    BLANK,
    "    // There is no system prompt here, so nothing has paid for that field's framing — and the",
    "    // summary is what brings the field into being. Charged on the way out instead, two turns and a",
    "    // summary come to exactly the window and arrive one token over it.",
    '    expect(labelsOf(fitted.messages)).toEqual(["cccc"]);',
    "    expect(fitted.tokens).toBe(8);",
    "  });",
    BLANK,
    opens(shape, "is refused when it overran the room reserved for it"),
    `    const refusal = ${awaited(shape)}refusalOf(CHAT, {`,
    "      ...EXACT,",
    "      contextWindow: 12,",
    "      reserveForSummary: 4,",
    '      summarise: (): string => "x".repeat(40),',
    "    });",
    BLANK,
    "    // Sending it would put the request over by however far the summariser overran — reported by the",
    "    // provider, from a stack that has nothing to do with the summary.",
    "    expect(refusal.needed).toBe(44);",
    "  });",
    "});",
  );
}

function middleOutCases(shape: Shape): string {
  const fit = `${awaited(shape)}fit`;

  return codeLines(
    'describe("keeping both ends", () => {',
    opens(shape, "keeps the oldest turns as well as the newest"),
    `    const fitted = ${fit}(CHAT, {`,
    "      ...EXACT,",
    "      contextWindow: 12,",
    "      reserveForHead: 4,",
    "    });",
    BLANK,
    "    // Whatever the conversation is about was said at the beginning, so the beginning is kept. What",
    '    // it leaves is a gap the model is not told about — between "aaaa" and "dddd" here.',
    '    expect(labelsOf(fitted.messages)).toEqual(["aaaa", "dddd", "eeee"]);',
    '    expect(labelsOf(fitted.dropped)).toEqual(["bbbb", "cccc"]);',
    "  });",
    BLANK,
    opens(shape, "spends nothing on the oldest turns when nothing was reserved for them"),
    `    const fitted = ${fit}(CHAT, {`,
    "      ...EXACT,",
    "      contextWindow: 12,",
    "      reserveForHead: 0,",
    "    });",
    BLANK,
    "    // Which is the plain sliding window this strategy was chosen over, and is why the reserve has no",
    "    // default: a zero it filled in for itself would be this, quietly.",
    '    expect(labelsOf(fitted.messages)).toEqual(["cccc", "dddd", "eeee"]);',
    "  });",
    BLANK,
    opens(shape, "does not give the oldest turns more than their allowance"),
    '    const chat = [said("aa"), replied("bb"), said("cc"), replied("dd"), said("ee")];',
    `    const fitted = ${fit}(chat, {`,
    "      ...EXACT,",
    "      contextWindow: 8,",
    "      reserveForHead: 6,",
    "    });",
    BLANK,
    "    // A large allowance is a real trade rather than a free one: the head has taken everything but",
    "    // the pinned turn, and what went is the exchange immediately before the question.",
    '    expect(labelsOf(fitted.messages)).toEqual(["aa", "bb", "cc", "ee"]);',
    '    expect(labelsOf(fitted.dropped)).toEqual(["dd"]);',
    "  });",
    BLANK,
    opens(shape, "does not let the oldest turns overspend the whole budget"),
    '    const chat = [said("aa"), replied("bb"), said("cc"), replied("dd"), said("ee")];',
    `    const fitted = ${fit}(chat, {`,
    "      ...EXACT,",
    "      contextWindow: 8,",
    "      reserveForHead: 1000,",
    "    });",
    BLANK,
    "    // An allowance larger than the room left is the room left, not a licence to exceed it.",
    "    expect(fitted.tokens).toBe(8);",
    "  });",
    "});",
  );
}

function estimateCases(shape: Shape): string {
  const fit = `${awaited(shape)}fit`;

  return codeLines(
    'describe("the default estimate", () => {',
    '  it("rounds up", () => {',
    "    // Guessing low causes exactly the rejection this file exists to prevent. Guessing high costs a",
    "    // turn of context, which is the affordable direction.",
    '    expect(estimateTokens("abcde")).toBe(2);',
    '    expect(estimateTokens("")).toBe(0);',
    "  });",
    BLANK,
    opens(shape, "is what a budget with no counter of its own uses"),
    `    const fitted = ${fit}([said("a".repeat(40))], ESTIMATED);`,
    BLANK,
    "    // Forty characters is ten tokens, and the framing this budget left switched on is four more.",
    "    expect(fitted.tokens).toBe(14);",
    "  });",
    "});",
  );
}

function refusal(shape: Shape): string {
  return documented(
    [
      shape.throwing
        ? "Refuses a conversation whose undroppable part does not fit."
        : "Reports a conversation whose undroppable part does not fit.",
      "One function, called from each place that can discover it, so that what a refusal carries is decided once. Nothing here shortens anything to avoid the refusal: what cannot be dropped is the system prompt and the newest turn, and a shortened version of either is a different request from the one the caller made.",
    ],
    shape.throwing
      ? dedent`
          function refused(needed: number, available: number): never {
            throw new ContextOverflowError(needed, available);
          }
        `
      : dedent`
          function refused(needed: number, available: number): Overflow {
            return { kind: "overflow", needed, available };
          }
        `,
  );
}

