/**
 * The `gateway` pattern: one typed boundary in front of a remote service.
 *
 * Fowler's gateway is an object that encapsulates access to an external system. What makes it worth
 * generating in TypeScript is not the encapsulation — anyone writes a module of `async` functions — but
 * the part that is always written and almost never written completely: the boundary between a response
 * and a domain value. Six things can go wrong on one call, and hand-written gateways collapse them into
 * a thrown `Error` whose message is the only surviving distinction. A caller that wants to retry a
 * timeout, return `undefined` for a 404, and page a human for a malformed body cannot do any of it from
 * a string.
 *
 * So the failure taxonomy is the pattern. A call reports one of six kinds — the service answered
 * unsuccessfully, the body was not JSON, the body was JSON and not what was promised, the request never
 * arrived, the budget ran out, the caller cancelled — and each carries what a handler needs to act on
 * it. A `switch` over those kinds is exhaustive, so adding a seventh is a compile error at every call
 * site rather than a case that silently falls through.
 *
 * Three seams follow from that, and each is here because the alternative is worse.
 *
 * The transport is a function, not `fetch`. The gateway never mentions `fetch`, so a test drives it with
 * a literal reply and a project with its own HTTP client keeps it. `transport: "fetch"` emits an adapter
 * beside the gateway rather than inside it, which is the difference between a testable boundary and one
 * that needs a network stub.
 *
 * Decoding is a function the caller supplies, not a schema library. A gateway that imported Zod would be
 * a gateway for Zod users; `Decoder<T>` is four lines to satisfy by hand and one line to satisfy with
 * `safeParse`. This is also where the sandbox's rule that a response body is `unknown` stops being a
 * constraint and starts being the design: there is no path from a reply to a `T` that does not go
 * through a decoder.
 *
 * A timeout is enforced rather than requested. `AbortSignal` is passed to the transport so a cooperative
 * one can stop its own work, *and* the call races the deadline, so a transport that ignores the signal
 * still cannot outlive the budget. Only doing the first is the common bug: the signal fires, nothing
 * listens, and the promise a caller is awaiting never settles.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { expectFileEntry } from "../expect-file.js";
import { dedent, documented, documentedAt, joinLines, sections, when } from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const gatewayPattern: PatternModule = {
  name: "gateway",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      fetching: options.transport === "fetch",
      results: options.errorMode === "result",
      cancellable: options.cancellation === "abort-signal",
      names: namesFor(context),
    };
    const n = shape.names;

    const files: RenderedFile[] = [{ path: `${n.stem}.ts`, role: "core", contents: core(shape) }];

    if (shape.fetching) {
      files.push({ path: `${n.adapterStem}.ts`, role: "adapter", contents: adapter(context, shape) });
    }

    files.push({
      path: `${n.stem}-example.ts`,
      role: "example",
      contents: example(context, shape),
    });

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({ path: `${n.stem}.test.ts`, role: "test", contents: tests(context, shape) });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

interface Shape {
  readonly fetching: boolean;
  readonly results: boolean;
  readonly cancellable: boolean;
  readonly names: Names;
}

/** Every name the templates use, derived once so two files cannot disagree about one. */
interface Names {
  readonly stem: string;
  /** The `fetch` adapter's file, under `transport: "fetch"`. */
  readonly adapterStem: string;
  /** The gateway interface: `OrderGateway`. */
  readonly gateway: string;
  /** Its constructor: `createOrderGateway`. */
  readonly build: string;
  /** What that constructor takes: `OrderGatewayConfig`. */
  readonly config: string;
  /** The transport port: `OrderTransport`. */
  readonly transport: string;
  readonly request: string;
  readonly reply: string;
  /** The verb union: `OrderHttpMethod`. */
  readonly method: string;
  /** Query values before encoding: `OrderQueryParams`. */
  readonly query: string;
  /** One call's declaration: `OrderEndpoint`. */
  readonly endpoint: string;
  /** Per-call overrides: `OrderCallOptions`. */
  readonly callOptions: string;
  readonly decoder: string;
  /** What a decoder returns: `OrderDecoded`. */
  readonly decoded: string;
  /** The failure union: `OrderGatewayFailure`. */
  readonly failure: string;
  /** Its prose form, exported because every caller needs one: `describeOrderGatewayFailure`. */
  readonly describe: string;
  /** Its thrown form, under `errorMode: throw`. */
  readonly error: string;
  /** The outcome union, under `errorMode: result`: `OrderCallOutcome`. */
  readonly outcome: string;
  readonly fetchTransport: string;
  readonly fetchLike: string;
  readonly fetchConfig: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;
  const stem = entity === undefined ? "gateway" : `${entity.kebab}-gateway`;

  return {
    stem,
    adapterStem: `${stem}-fetch`,
    gateway: `${prefix}Gateway`,
    build: `create${prefix}Gateway`,
    config: `${prefix}GatewayConfig`,
    transport: `${prefix}Transport`,
    request: `${prefix}TransportRequest`,
    reply: `${prefix}TransportReply`,
    method: `${prefix}HttpMethod`,
    query: `${prefix}QueryParams`,
    endpoint: `${prefix}Endpoint`,
    callOptions: `${prefix}CallOptions`,
    decoder: `${prefix}Decoder`,
    decoded: `${prefix}Decoded`,
    failure: `${prefix}GatewayFailure`,
    describe: `describe${prefix}GatewayFailure`,
    error: `${prefix}GatewayError`,
    outcome: `${prefix}CallOutcome`,
    fetchTransport: `create${prefix}FetchTransport`,
    fetchLike: `${prefix}FetchLike`,
    fetchConfig: `${prefix}FetchTransportConfig`,
  };
}

/** What a call resolves to: the outcome union, or the value itself when failures are thrown. */
function returned(shape: Shape, type: string): string {
  return shape.results ? `${shape.names.outcome}<${type}>` : type;
}

/** Indents every line by `width`, leaving blank lines blank. */
function indentBy(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `${pad}${line}`))
    .join("\n");
}

/** The verbs that carry a body, in a fixed order so the emitted members do not move. */
const BODIED: readonly { readonly name: string; readonly verb: string }[] = [
  { name: "post", verb: "POST" },
  { name: "put", verb: "PUT" },
  { name: "patch", verb: "PATCH" },
];

function core(shape: Shape): string {
  const n = shape.names;

  return sections(
    ports(shape),
    decoding(shape),
    failures(shape),
    shape.results ? outcomeType(shape) : errorClass(shape),
    requestTypes(shape),
    gatewayInterface(shape),
    builder(shape),
    when(shape.cancellable, deadline(n)),
  );
}

/** The transport seam: what a gateway hands out and what it expects back. */
function ports(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "The verbs a gateway will send.",
        "A closed union rather than `string`, so a typo in an endpoint declaration is caught where it is written. The verbs missing from it — `HEAD`, `OPTIONS`, `TRACE` — are ones a service client does not issue on a caller's behalf.",
      ],
      `export type ${n.method} = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";`,
    ),
    documented(
      [
        "One request, fully resolved: nothing left for a transport to decide.",
        "The URL is absolute and the body already serialised, which is what keeps a transport small enough to be obviously correct. A transport that had to join a base and a path, or choose a content type, would be a second place those decisions live — and the second place is always the one that gets them wrong.",
      ],
      dedent`
        export interface ${n.request} {
          readonly method: ${n.method};
          /** Absolute, with the query string already appended. */
          readonly url: string;
          readonly headers: Readonly<Record<string, string>>;
          /** Absent for a request that carries none, rather than an empty string. */
          readonly body: string | undefined;
        }
      `,
    ),
    documented(
      [
        "One reply, still untouched: a status and a body as text.",
        "The body is a `string` rather than a parsed value, because a body that is not JSON is a failure the gateway reports with the text that caused it — and a transport that parsed would have to invent a way to say so. `status` is carried rather than a boolean, since a caller distinguishing 404 from 500 needs the number.",
      ],
      dedent`
        export interface ${n.reply} {
          readonly status: number;
          readonly statusText: string;
          readonly headers: Readonly<Record<string, string>>;
          /** Empty for a reply that carries no body, such as a 204. */
          readonly body: string;
        }
      `,
    ),
    documented(
      [
        "Moving one request and returning one reply. The whole of what a gateway needs from the network.",
        shape.cancellable
          ? "A transport that honours the signal should stop its own work and reject when it fires; one that ignores it is still bounded, because the gateway races the deadline rather than trusting the transport to observe it."
          : "Nothing here can be cancelled: that is what `cancellation: \"none\"` means. A transport with its own timeout is the only bound on a call.",
        "A function type rather than an interface with a `send` method, because there is one operation and a function is the smallest thing that can be passed, stubbed, and wrapped. Retry and circuit-breaking compose here, by returning a transport that calls another.",
      ],
      shape.cancellable
        ? dedent`
            export type ${n.transport} = (
              request: ${n.request},
              signal?: AbortSignal,
            ) => Promise<${n.reply}>;
          `
        : `export type ${n.transport} = (request: ${n.request}) => Promise<${n.reply}>;`,
    ),
  );
}

/** The decoder seam. */
function decoding(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "What a decoder answers with.",
        "`problems` rather than one message, because a body wrong in three ways should say so once instead of over three round trips.",
        "Compare the discriminant, as in `if (decoded.ok === false)`, rather than testing it for truthiness. Both narrow under `strict`, but only the comparison narrows in a project with `strictNullChecks` off.",
      ],
      dedent`
        export type ${n.decoded}<T> =
          | { readonly ok: true; readonly value: T }
          | { readonly ok: false; readonly problems: readonly string[] };
      `,
    ),
    documented(
      [
        "Turns a parsed body into the value the caller asked for, or says why it cannot.",
        "The input is `unknown` because that is what it is: a JSON body is whatever the service sent, and the only thing standing between it and the rest of the program is this function. There is deliberately no way to declare an endpoint without one.",
        "A function rather than a schema, so the gateway depends on no validation library while staying a thin adapter for any of them:",
        dedent`
          \`\`\`ts
          const decodeInvoice: ${n.decoder}<Invoice> = (body) => {
            const parsed = invoiceSchema.safeParse(body);
            if (parsed.success) return { ok: true, value: parsed.data };

            return { ok: false, problems: parsed.error.issues.map((i) => i.message) };
          };
          \`\`\`
        `,
      ],
      `export type ${n.decoder}<T> = (body: unknown) => ${n.decoded}<T>;`,
    ),
  );
}

/** The failure union, and the prose form of it. */
function failures(shape: Shape): string {
  const n = shape.names;

  const arms = [
    "  /** The service answered, and not with a success. `body` is the text it sent. */",
    "  | {",
    '      readonly kind: "status";',
    "      readonly status: number;",
    "      readonly statusText: string;",
    "      readonly body: string;",
    "    }",
    "  /** The body was not JSON. Usually an HTML error page from something in front of the service. */",
    '  | { readonly kind: "malformed"; readonly body: string; readonly cause: unknown }',
    "  /** The body was JSON, and not what the decoder was promised. */",
    '  | { readonly kind: "invalid"; readonly problems: readonly string[] }',
    "  /** The request never arrived: DNS, TLS, a refused connection, a dropped socket. */",
    '  | { readonly kind: "transport"; readonly cause: unknown }',
    ...(shape.cancellable
      ? [
          "  /** The budget ran out. Nothing is known about whether the service acted. */",
          '  | { readonly kind: "timeout"; readonly timeoutMs: number }',
          "  /** The caller withdrew, so this is not the service's failure and not worth reporting as one. */",
          '  | { readonly kind: "cancelled"; readonly reason: unknown }',
        ]
      : []),
  ];

  // The terminator is added here rather than written on the last arm, so that turning cancellation off
  // cannot leave a union with no semicolon or one with two.
  const terminated = [...arms.slice(0, -1), `${arms.at(-1) ?? ""};`];

  return sections(
    documented(
      [
        "Everything that can go wrong on one call, as one value.",
        "The kinds are separate because the reactions are: a `timeout` is worth retrying and a `status` of 400 never is; a 404 is often an empty result rather than an error at all; `malformed` and `invalid` both mean the contract is broken, but the first blames the network path and the second the service. A gateway that threw one `Error` for all six would leave every call site parsing a message to decide.",
        "Each kind carries what a handler needs and nothing it would have to ask for: the status *and* the body, the decoder's problems, the budget that was exceeded. `cause` is `unknown` rather than `Error`, because a rejected promise can carry anything.",
      ],
      joinLines(`export type ${n.failure} =`, terminated),
    ),
    documented(
      [
        "One sentence for a failure, for a log line or a message to a person.",
        `Exported rather than kept private, because every caller writes this function otherwise${shape.results ? "" : " — and it is what the thrown error's message already is"}. The \`switch\` is exhaustive and the assignment under it is what enforces that: adding a kind without handling it here stops the file compiling, rather than producing a sentence that says nothing.`,
      ],
      dedent`
        export function ${n.describe}(failure: ${n.failure}): string {
          switch (failure.kind) {
        ${indentBy(
          joinLines(
            dedent`
              case "status":
                return \`The service answered \${String(failure.status)} \${failure.statusText}.\`;
              case "malformed":
                return "The service answered with a body that is not JSON.";
              case "invalid":
                return \`The response was not what was expected: \${failure.problems.join("; ")}.\`;
              case "transport":
                return "The request did not reach the service.";
            `,
            when(
              shape.cancellable,
              dedent`
                case "timeout":
                  return \`The request did not finish within \${String(failure.timeoutMs)}ms.\`;
                case "cancelled":
                  return "The request was cancelled before it finished.";
              `,
            ),
          ),
          4,
        )}
          }

          // Unreachable while every kind is handled. \`never\` is the point: the compiler narrows
          // \`failure\` to nothing here only because the cases above are exhaustive, so a kind added to
          // the union without a case turns this line into an error.
          const unhandled: never = failure;
          return String(unhandled);
        }
      `,
    ),
  );
}

function outcomeType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "What one call resolves to.",
      "The same shape as the `result` pattern's type — a literal `ok` discriminant with `value` and `error` arms — so a caller who has generated that pattern can pass this into its combinators, and one who has not still narrows it in an `if`.",
      "Compare the discriminant, as in `if (outcome.ok === false)`, rather than testing it for truthiness. Both narrow under `strict`, but only the comparison narrows in a project with `strictNullChecks` off, where `if (!outcome.ok)` leaves the type unnarrowed and reading `error` off it is an error.",
      "`status` rides along on success because 200 and 201 mean different things to a caller who just created something, and a gateway that discarded it would send them back for a second surface to find out.",
    ],
    dedent`
      export type ${n.outcome}<T> =
        | { readonly ok: true; readonly value: T; readonly status: number }
        | { readonly ok: false; readonly error: ${n.failure} };
    `,
  );
}

function errorClass(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Raised by every call that fails.",
      "One class for all six kinds, with the kind on `failure` rather than in a subclass per kind. A `catch` block should need one `instanceof` and then a `switch` — a hierarchy would make the exhaustiveness check impossible, since there is no way to prove a chain of `instanceof` covered every subclass.",
      "`failure` is the same value the result rendering returns, so the two renderings of this pattern report identically and a call site can move between them by changing how it is reached, not what it inspects.",
    ],
    dedent`
      export class ${n.error} extends Error {
        readonly failure: ${n.failure};

        constructor(failure: ${n.failure}) {
          super(${n.describe}(failure));
          this.name = "${n.error}";
          this.failure = failure;
        }
      }
    `,
  );
}

/** Endpoint, call options, and config. */
function requestTypes(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "Query values as a caller has them, before anything is encoded.",
        "Numbers and booleans are accepted because that is what a caller holds, and `String(value)` is the conversion they would otherwise write at every call. `undefined` is accepted and *dropped*: an unset filter should not become `?status=undefined`, which is the literal string a server then fails to parse.",
      ],
      `export type ${n.query} = Readonly<Record<string, string | number | boolean | undefined>>;`,
    ),
    documented(
      [
        "One operation the service offers: where it is, how it is reached, and how to read the answer.",
        "Worth declaring once as a value rather than passing three arguments at each call site, because an endpoint is a fact about the service and shared by everyone who uses it. The decoder travelling with it is what makes `T` follow from the endpoint instead of from a type argument someone has to remember.",
      ],
      dedent`
        export interface ${n.endpoint}<T> {
          readonly method: ${n.method};
          /** Relative to the gateway's base. A leading slash is tolerated and ignored. */
          readonly path: string;
          readonly decode: ${n.decoder}<T>;
        }
      `,
    ),
    interfaceOf(
      ["What one call may add or override."],
      `export interface ${n.callOptions} {`,
      [
        `  readonly query?: ${n.query};`,
        documentedAt(
          2,
          ["Merged over the gateway's own headers, so a call can override one."],
          "readonly headers?: Readonly<Record<string, string>>;",
        ),
        documentedAt(
          2,
          [
            "Serialised as JSON. `undefined` sends no body, which is not the same as sending `null`.",
          ],
          "readonly body?: unknown;",
        ),
        ...(shape.cancellable
          ? [
              "  readonly signal?: AbortSignal;",
              documentedAt(
                2,
                ["Overrides the gateway's default budget for this call alone."],
                "readonly timeoutMs?: number;",
              ),
            ]
          : []),
      ],
    ),
    interfaceOf(
      ["What a gateway needs to exist."],
      `export interface ${n.config} {`,
      [
        documentedAt(
          2,
          [
            "Where the service lives, including any path prefix it is mounted under.",
            `A trailing slash is added if it is missing, because without one the prefix is silently lost — see \`${n.build}\`.`,
          ],
          "readonly baseUrl: string;",
        ),
        `  readonly transport: ${n.transport};`,
        documentedAt(
          2,
          ["Sent with every request: an API key, an accept header, a user agent."],
          "readonly headers?: Readonly<Record<string, string>>;",
        ),
        ...(shape.cancellable
          ? [
              documentedAt(
                2,
                [
                  "The budget for every call, unless one overrides it.",
                  "Optional, and leaving it out means calls are bounded only by the transport, which for most HTTP clients means not bounded at all.",
                ],
                "readonly timeoutMs?: number;",
              ),
            ]
          : []),
      ],
    ),
  );
}

/**
 * An interface from its members, with one blank line between them.
 *
 * Members are assembled as a list rather than interpolated into one template literal, and the reason is
 * a failure worth naming. A conditional member written as `${when(…, dedent`…`)}` loses the newline that
 * would have separated it from the member above — `dedent` strips leading blank lines — so a member
 * whose first line is a doc comment lands *after* the previous member's semicolon. Prettier keeps it
 * there, as a trailing comment, and the comment reflow step skips trailing comments on purpose. The
 * result is a 93-column comment documenting the wrong member, in one option combination only.
 */
function interfaceOf(
  paragraphs: readonly string[],
  open: string,
  members: readonly string[],
): string {
  return joinLines(documented(paragraphs, open), members.join("\n\n"), "}");
}

function gatewayInterface(shape: Shape): string {
  const n = shape.names;
  const result = returned(shape, "T");

  const members = [
    documentedAt(
      2,
      [
        "The absolute URL a path and query would be sent to.",
        "Exported because it is the part of a gateway most worth checking and least worth guessing at: base joining has two silent failure modes, both of which drop a path prefix. Also what a caller needs to build a link, or to log where a call went.",
      ],
      `url(path: string, query?: ${n.query}): string;`,
    ),
    documentedAt(
      2,
      [
        "Calls one endpoint.",
        shape.results
          ? "Never rejects for anything the service or the network did: those arrive as the failure arm. A rejection from here means the decoder itself threw, which is a bug in the decoder rather than an outcome to handle."
          : `Raises \`${n.error}\` for anything the service or the network did, with the kind on \`failure\`.`,
        "The verb methods below are this one with the method filled in. They exist because `gateway.get(path, decode)` is what a call site reads best, and this exists because an endpoint declared once and shared is what a client should be built from.",
      ],
      `call<T>(endpoint: ${n.endpoint}<T>, options?: ${n.callOptions}): Promise<${result}>;`,
    ),
    documentedAt(
      2,
      ["Sends `GET` to `path`."],
      `get<T>(path: string, decode: ${n.decoder}<T>, options?: ${n.callOptions}): Promise<${result}>;`,
    ),
    ...BODIED.map(({ name, verb }) =>
      documentedAt(
        2,
        [
          `Sends \`${verb}\` to \`path\` with \`body\` serialised as JSON.`,
          ...(name === "post"
            ? [
                "The body is a parameter rather than an option because a request with this verb and no body is nearly always a mistake, and a parameter is the only way to say so in a type. `undefined` is still accepted, for the services that want one anyway.",
              ]
            : []),
        ],
        dedent`
          ${name}<T>(
            path: string,
            body: unknown,
            decode: ${n.decoder}<T>,
            options?: Omit<${n.callOptions}, "body">,
          ): Promise<${result}>;
        `,
      ),
    ),
    documentedAt(
      2,
      [
        "Sends `DELETE` to `path`.",
        "A decoder is still required, because a service that answers a delete with the deleted record is as common as one that answers with nothing — and a decoder for nothing is three lines.",
      ],
      `delete<T>(path: string, decode: ${n.decoder}<T>, options?: ${n.callOptions}): Promise<${result}>;`,
    ),
  ];

  return joinLines(
    documented(
      [
        `${n.gateway}: the service, as this codebase wants to see it.`,
        "Every method resolves to a value the caller declared the shape of, or reports one of the failure kinds. Nothing on this interface exposes a status code, a header, or a response object, which is the boundary the pattern is named for: past here, nothing knows the service is remote.",
      ],
      `export interface ${n.gateway} {`,
    ),
    members.join("\n\n"),
    "}",
  );
}

function builder(shape: Shape): string {
  const n = shape.names;

  const verbs = [
    // One entry, so the two shorthands sit together rather than with a blank line between them.
    "url,\ncall,",
    dedent`
      get<T>(path: string, decode: ${n.decoder}<T>, options?: ${n.callOptions}) {
        return call({ method: "GET", path, decode }, options);
      },
    `,
    ...BODIED.map(
      ({ name, verb }) => dedent`
        ${name}<T>(
          path: string,
          body: unknown,
          decode: ${n.decoder}<T>,
          options?: Omit<${n.callOptions}, "body">,
        ) {
          return call({ method: "${verb}", path, decode }, { ...options, body });
        },
      `,
    ),
    dedent`
      delete<T>(path: string, decode: ${n.decoder}<T>, options?: ${n.callOptions}) {
        return call({ method: "DELETE", path, decode }, options);
      },
    `,
  ];

  return documented(
    [
      `Builds \`${n.gateway}\` over a transport.`,
      "The type parameters on the methods are written out rather than inherited from the interface, which contextual typing would otherwise supply. Declaring one opts a method out of contextual typing entirely, so its parameters have to be annotated too — the two go together, and the alternative is an arrow whose `T` is fixed to `unknown` at the point it is assigned.",
    ],
    dedent`
      export function ${n.build}(config: ${n.config}): ${n.gateway} {
        // Normalised once, and the reason is a rule of URL resolution that costs a path prefix every
        // time someone meets it. \`new URL("orders", "https://api.example.com/v1")\` is
        // "https://api.example.com/orders" — without a trailing slash the base's last segment names a
        // file, and a relative path replaces it rather than joining under it. Versioned bases are the
        // common case, so this is the common bug.
        const base = config.baseUrl.endsWith("/") ? config.baseUrl : \`\${config.baseUrl}/\`;
        const defaults = config.headers ?? {};

      ${indentBy(urlHelper(shape), 2)}

      ${indentBy(failHelper(shape), 2)}

      ${indentBy(callImplementation(shape), 2)}

        return {
      ${indentBy(verbs.join("\n\n"), 4)}
        };
      }
    `,
  );
}

function urlHelper(shape: Shape): string {
  const n = shape.names;

  return dedent`
    const url = (path: string, query?: ${n.query}): string => {
      // The leading slash is stripped for the mirror-image reason: "/orders" is root-relative, so it
      // discards the base's path as surely as a base without a trailing slash does. Tolerating both
      // spellings means an endpoint table can be written either way and still work.
      const resolved = new URL(path.startsWith("/") ? path.slice(1) : path, base);

      for (const [name, value] of Object.entries(query ?? {})) {
        // Skipped rather than encoded: an absent filter is not a filter set to the four characters
        // "null" or the nine characters "undefined".
        if (value === undefined) continue;
        resolved.searchParams.set(name, String(value));
      }

      return resolved.toString();
    };
  `;
}

/**
 * The one line the two error modes differ by.
 *
 * Both renderings are built from the same `return fail(…)` statements, so the throwing form is not a
 * second implementation of the same logic — it is the same logic with a helper that does not return.
 * That is what keeps the two from drifting as this pattern changes.
 */
function failHelper(shape: Shape): string {
  const n = shape.names;

  return shape.results
    ? dedent`
        // Generic so that \`return fail(…)\` infers the call's own \`T\` from its return position, which
        // is what lets every failure below be written once.
        const fail = <T>(error: ${n.failure}): ${n.outcome}<T> => ({ ok: false, error });
      `
    : dedent`
        // Returns \`never\`, so \`return fail(…)\` typechecks in a function returning anything.
        const fail = (error: ${n.failure}): never => {
          throw new ${n.error}(error);
        };
      `;
}

function callImplementation(shape: Shape): string {
  const n = shape.names;

  const send = shape.cancellable
    ? dedent`
        const timeoutMs = options.timeoutMs ?? config.timeoutMs;
        const deadline = startDeadline(options.signal, timeoutMs);
        let reply: ${n.reply};

        try {
          // Raced as well as signalled. The signal is how a cooperative transport stops its own work;
          // the race is why a transport that ignores it still cannot hold this call past the budget.
          // Only passing the signal is the usual version of this code, and it hangs forever against
          // any client that does not implement cancellation.
          reply = await deadline.race(config.transport(request, deadline.signal));
        } catch (cause) {
          return fail(classify(cause, deadline, options.signal, timeoutMs));
        } finally {
          // Whatever happened, the timer is cleared and the caller's signal is unsubscribed from. A
          // signal that outlives the call, one per page say, would otherwise accumulate one listener
          // per request that made it.
          deadline.release();
        }
      `
    : dedent`
        let reply: ${n.reply};

        try {
          reply = await config.transport(request);
        } catch (cause) {
          return fail({ kind: "transport", cause });
        }
      `;

  return dedent`
    const call = async <T>(
      endpoint: ${n.endpoint}<T>,
      options: ${n.callOptions} = {},
    ): Promise<${returned(shape, "T")}> => {
      const sending = options.body !== undefined;

      const request: ${n.request} = {
        method: endpoint.method,
        url: url(endpoint.path, options.query),
        // The call's own headers go last, so one call can override a default. The content type sits
        // between them: set when there is a body, still overridable by a caller sending something
        // that is JSON-shaped but not \`application/json\`.
        headers: {
          ...defaults,
          ...(sending ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        body: sending ? JSON.stringify(options.body) : undefined,
      };

    ${indentBy(send, 2)}

      if (reply.status < 200 || reply.status >= 300) {
        return fail({
          kind: "status",
          status: reply.status,
          statusText: reply.statusText,
          body: reply.body,
        });
      }

      let parsed: unknown;

      try {
        // An empty body parses as \`undefined\` rather than failing. A 204 carries none by definition,
        // and \`JSON.parse("")\` throws — so without this every successful delete would be reported as
        // a malformed response.
        parsed = reply.body === "" ? undefined : JSON.parse(reply.body);
      } catch (cause) {
        return fail({ kind: "malformed", body: reply.body, cause });
      }

      const decoded = endpoint.decode(parsed);

      if (decoded.ok === false) {
        return fail({ kind: "invalid", problems: decoded.problems });
      }

      return ${shape.results ? "{ ok: true, value: decoded.value, status: reply.status }" : "decoded.value"};
    };
  `;
}

/**
 * The deadline machinery, under `cancellation: "abort-signal"`.
 *
 * Module-scoped functions below the constructor rather than closures inside it: they capture nothing
 * from the config, and a caller reading the constructor should not have to scroll past forty lines of
 * timer bookkeeping to reach the methods.
 */
function deadline(n: Names): string {
  return sections(
    documented(
      ["One call's budget: a signal to pass on, a race to enforce it, and a reason afterwards."],
      dedent`
        interface Deadline {
          /** Handed to the transport, so one that honours cancellation stops its own work. */
          readonly signal: AbortSignal | undefined;
          /** Settles as soon as the budget is spent, even if the transport never does. */
          race<T>(work: Promise<T>): Promise<T>;
          /** Whether the timeout ended the call, as opposed to the caller. */
          expired(): boolean;
          /** Clears the timer and unsubscribes from the caller's signal. */
          release(): void;
        }
      `,
    ),
    documented(
      [
        "Combines the caller's signal and the timeout into one.",
        "`AbortSignal.any` says this in a line and arrived in Node 20, which is younger than the runtimes a generated gateway has to compile for — so the combination is done by hand, which also keeps the reason for the abort recoverable.",
        "When there is neither a signal nor a budget the whole thing collapses to a pass-through, so a gateway configured without a timeout pays nothing for the machinery.",
      ],
      dedent`
        function startDeadline(
          signal: AbortSignal | undefined,
          timeoutMs: number | undefined,
        ): Deadline {
          if (signal === undefined && timeoutMs === undefined) {
            return {
              signal: undefined,
              race<T>(work: Promise<T>): Promise<T> {
                return work;
              },
              expired: () => false,
              release: () => {},
            };
          }

          const controller = new AbortController();
          let expired = false;

          // Built from the controller's own signal rather than from the two sources, so there is one
          // place a call can end and one reason to read afterwards. Nothing ever handles this promise
          // unless \`race\` is called, and \`race\` is called on every path that creates it.
          const aborted = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => {
                reject(controller.signal.reason);
              },
              { once: true },
            );
          });

          const timer =
            timeoutMs === undefined
              ? undefined
              : setTimeout(() => {
                  expired = true;
                  controller.abort(new Error(\`Timed out after \${String(timeoutMs)}ms.\`));
                }, timeoutMs);

          // \`signal?.reason\` rather than \`signal.reason\`: this only runs when the signal exists, but a
          // closure keeps no narrowing, and the optional access is cheaper than an assertion that
          // claims something the compiler cannot check.
          const forward = (): void => {
            controller.abort(signal?.reason);
          };

          if (signal !== undefined) {
            // Already aborted is not a special case worth a branch of its own — a signal handed in
            // spent means the call is over before it starts, and \`forward\` says that.
            if (signal.aborted) forward();
            else signal.addEventListener("abort", forward, { once: true });
          }

          return {
            signal: controller.signal,
            race<T>(work: Promise<T>): Promise<T> {
              return Promise.race([work, aborted]);
            },
            expired: () => expired,
            release: () => {
              clearTimeout(timer);
              if (signal !== undefined) signal.removeEventListener("abort", forward);
            },
          };
        }
      `,
    ),
    documented(
      [
        "Which failure a rejected transport call was.",
        "The order is the whole of it. A timeout aborts a controller of this gateway's own, so the caller's signal is untouched and `expired` is the only thing that can tell a spent budget from a withdrawn caller. Checking the caller first would report every timeout as a cancellation.",
      ],
      dedent`
        function classify(
          cause: unknown,
          deadline: Deadline,
          signal: AbortSignal | undefined,
          timeoutMs: number | undefined,
        ): ${n.failure} {
          if (deadline.expired() && timeoutMs !== undefined) {
            return { kind: "timeout", timeoutMs };
          }

          if (signal?.aborted === true) {
            return { kind: "cancelled", reason: signal.reason };
          }

          return { kind: "transport", cause };
        }
      `,
    ),
  );
}

/**
 * The `fetch`-backed transport, under `transport: "fetch"`.
 *
 * A separate file, and a separate concept: the gateway is the boundary to a *service*, this is the
 * boundary to a *client*. Keeping them apart is what lets a test drive the gateway with a literal reply,
 * and what lets a project on Axios or on its own instrumented client keep everything above.
 */
function adapter(context: RenderContext, shape: Shape): string {
  const n = shape.names;

  return sections(
    dedent`
      /**
       * \`fetch\` for the gateway's transport port.
       *
       * \`RequestInit\` and \`Response\` are the host's own declarations — from \`@types/node\`, or from the
       * DOM lib in a browser project — not types this bundle defines. Nothing here needs a package.
       */
    `,
    importsFrom(context.conventions, siblingSpecifier(context.conventions, n.stem), {
      types: [n.transport],
    }),
    documented(
      [
        "The part of `fetch` this transport uses.",
        "Narrower than the real signature on purpose. A parameter typed this way accepts the global `fetch`, a stub in a test, and a wrapped client that adds a header — while stating that nothing here depends on `Request`, on a streaming body, or on any of the rest.",
      ],
      `export type ${n.fetchLike} = (url: string | URL, init?: RequestInit) => Promise<Response>;`,
    ),
    documented(
      ["What the transport needs, which is almost nothing."],
      dedent`
        export interface ${n.fetchConfig} {
          /**
           * Defaults to the global \`fetch\`.
           *
           * Worth overriding for a test, and for the common case of a \`fetch\` already wrapped in
           * tracing or in a proxy agent.
           */
          readonly send?: ${n.fetchLike};
        }
      `,
    ),
    documented(
      [
        "Builds a transport over `fetch`.",
        "Reads the body as text and returns it unparsed, which is what the gateway wants: the decision that a body is not JSON belongs with the failure taxonomy, not here. It also means a non-JSON error page from a proxy survives as the text a human needs to see rather than becoming a parse exception with none of it.",
        "Nothing is caught. A `fetch` that rejects — DNS, TLS, a refused connection, an abort — rejects out of here, and the gateway is what turns that into a failure kind, since it is the only party that knows whether a deadline was in play.",
      ],
      dedent`
        export function ${n.fetchTransport}(config: ${n.fetchConfig} = {}): ${n.transport} {
          // Wrapped rather than referenced. Passing the global directly would work in every runtime
          // that matters and is still the kind of thing that breaks when a host implements \`fetch\` as
          // a method that needs its receiver.
          const send = config.send ?? ((url, init) => fetch(url, init));

          return async (request${when(shape.cancellable, ", signal")}) => {
            const response = await send(request.url, {
              method: request.method,
              headers: request.headers,
              // Left out when absent rather than passed as \`undefined\`. \`RequestInit\` belongs to the
              // host, so its optional fields cannot be widened here, and under
              // \`exactOptionalPropertyTypes\` an optional field of someone else's interface does not
              // accept an explicit \`undefined\`. A spread says "no body" without saying it twice.
              ...(request.body === undefined ? {} : { body: request.body }),${when(
                shape.cancellable,
                "\n      ...(signal === undefined ? {} : { signal }),",
              )}
            });

            // Collected into a plain record so that nothing above this file needs \`Headers\`, which is
            // a host type with three spellings of iteration across runtimes. Names arrive lowercased
            // from every implementation, which is the case-insensitive comparison a caller would
            // otherwise have to write.
            const headers: Record<string, string> = {};

            response.headers.forEach((value, name) => {
              headers[name] = value;
            });

            return {
              status: response.status,
              statusText: response.statusText,
              headers,
              body: await response.text(),
            };
          };
        }
      `,
    ),
  );
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  return sections(
    dedent`
      /**
       * One service, as a caller sees it.
       *
       * The decoder is written by hand here so that this file depends on nothing. In a project with a
       * schema library it is one line — see the doc on \`${n.decoder}\` — and the shape of everything
       * else is unchanged.
       */
    `,
    joinLines(
      importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
        values: [n.build, ...(shape.results ? [n.describe] : [n.error])],
        types: [n.decoder, n.endpoint, n.failure, ...(shape.fetching ? [] : [n.transport])],
      }),
      when(
        shape.fetching,
        importsFrom(conventions, siblingSpecifier(conventions, n.adapterStem), {
          values: [n.fetchTransport],
        }),
      ),
    ),
    dedent`
      export interface Invoice {
        readonly id: string;
        readonly totalCents: number;
        readonly paid: boolean;
      }
    `,
    documented(
      [
        "The only path from a response body to an `Invoice`.",
        "Destructured before it is checked, so that narrowing survives: `typeof record.id === \"string\"` narrows nothing that outlives the `if`, which is why hand-written decoders are usually a pile of casts.",
      ],
      dedent`
        export const decodeInvoice: ${n.decoder}<Invoice> = (body) => {
          if (typeof body !== "object" || body === null) {
            return { ok: false, problems: ["expected an object"] };
          }

          const { id, totalCents, paid } = body as Record<string, unknown>;

          if (
            typeof id !== "string" ||
            typeof totalCents !== "number" ||
            typeof paid !== "boolean"
          ) {
            // Every problem at once rather than the first, because someone correcting a fixture or a
            // contract wants the whole list in one round trip.
            return {
              ok: false,
              problems: [
                ...(typeof id === "string" ? [] : ["id must be a string"]),
                ...(typeof totalCents === "number" ? [] : ["totalCents must be a number"]),
                ...(typeof paid === "boolean" ? [] : ["paid must be a boolean"]),
              ],
            };
          }

          return { ok: true, value: { id, totalCents, paid } };
        };
      `,
    ),
    when(
      !shape.fetching,
      documented(
        [
          "Stands in for the HTTP client this project already has.",
          '`transport: "port-only"` was asked for, so no adapter was generated: this is the seam where an Axios instance, an instrumented `fetch`, or a service mesh client goes. It answers with a fixed invoice here so that the file compiles and runs on its own.',
        ],
        dedent`
          const client: ${n.transport} = () =>
            Promise.resolve({
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: "inv_814", totalCents: 1250, paid: false }),
            });
        `,
      ),
    ),
    documented(
      [
        "The service, configured once.",
        "The base carries a path prefix, which is the case that makes URL joining worth a method of its own.",
      ],
      dedent`
        export const invoices = ${n.build}({
          baseUrl: "https://api.example.com/v1",
          transport: ${shape.fetching ? `${n.fetchTransport}()` : "client"},
          headers: { accept: "application/json" },${when(shape.cancellable, "\n  timeoutMs: 5_000,")}
        });
      `,
    ),
    documented(
      [
        "An endpoint declared once and shared, which is what `call` is for.",
        "Worth doing wherever more than one place issues the same request: the path and the decoder stop being repeated, and the endpoint becomes the thing a test can point somewhere else.",
      ],
      dedent`
        const currentInvoice: ${n.endpoint}<Invoice> = {
          method: "GET",
          path: "invoices/current",
          decode: decodeInvoice,
        };
      `,
    ),
    documented(
      [
        "Whether the same request is worth sending again.",
        "This is what the failure kinds are for. The `switch` is exhaustive, so a kind added to the union turns this into a compile error rather than leaving a retry policy that quietly treats the new case as permanent.",
      ],
      dedent`
        export function retryable(failure: ${n.failure}): boolean {
          switch (failure.kind) {
        ${indentBy(retryableArms(shape), 4)}
          }

          const unhandled: never = failure;
          return Boolean(unhandled);
        }
      `,
    ),
    documented(
      [
        "One invoice, or nothing if the service does not have it.",
        "A 404 is an answer rather than a failure, and turning it into one here is why the status is on the failure value instead of only in a message.",
      ],
      shape.results
        ? dedent`
            export async function loadInvoice(id: string): Promise<Invoice | undefined> {
              const outcome = await invoices.get(\`invoices/\${id}\`, decodeInvoice);

              if (outcome.ok === true) return outcome.value;
              if (outcome.error.kind === "status" && outcome.error.status === 404) return undefined;

              throw new Error(${n.describe}(outcome.error));
            }
          `
        : dedent`
            export async function loadInvoice(id: string): Promise<Invoice | undefined> {
              try {
                return await invoices.get(\`invoices/\${id}\`, decodeInvoice);
              } catch (error) {
                // One \`instanceof\`, and then the same value the result rendering returns.
                if (
                  error instanceof ${n.error} &&
                  error.failure.kind === "status" &&
                  error.failure.status === 404
                ) {
                  return undefined;
                }

                throw error;
              }
            }
          `,
    ),
    documented(
      ["The shared endpoint, and a request that carries a body."],
      shape.results
        ? dedent`
            export async function currentTotalCents(): Promise<number> {
              const outcome = await invoices.call(currentInvoice);
              return outcome.ok === true ? outcome.value.totalCents : 0;
            }

            export async function raiseInvoice(totalCents: number): Promise<string | undefined> {
              const outcome = await invoices.post("invoices", { totalCents }, decodeInvoice);
              return outcome.ok === true ? outcome.value.id : undefined;
            }
          `
        : dedent`
            export async function currentTotalCents(): Promise<number> {
              return (await invoices.call(currentInvoice)).totalCents;
            }

            export async function raiseInvoice(totalCents: number): Promise<string> {
              return (await invoices.post("invoices", { totalCents }, decodeInvoice)).id;
            }
          `,
    ),
  );
}

/**
 * The arms of the example's retry decision.
 *
 * Assembled with `joinLines` rather than interpolated, for the reason `interfaceOf` records: a
 * conditional block whose first line is a comment loses the newline above it and becomes a trailing
 * comment on the line before.
 */
function retryableArms(shape: Shape): string {
  return joinLines(
    when(
      shape.cancellable,
      dedent`
        // Nothing was learned about whether the service acted, which is exactly the case where a
        // second identical request is the same request — and where an idempotency key earns its keep.
        case "timeout":
      `,
    ),
    dedent`
      case "transport":
        return true;
      // A 429 or a 5xx says "not now". Every other status is the same answer however often it is
      // asked for.
      case "status":
        return failure.status === 429 || failure.status >= 500;
      // The service answered and the answer was wrong. Repeating the call repeats the body.
      case "malformed":
      case "invalid":
        return false;
    `,
    when(
      shape.cancellable,
      dedent`
        // The caller withdrew. Retrying would be doing work nobody is waiting for.
        case "cancelled":
          return false;
      `,
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
          importsFrom(conventions, siblingSpecifier(conventions, "expect"), { values: ["expect"] }),
        )
      : importsFrom(conventions, "vitest", {
          values: ["describe", "expect", "it"],
        });

  return sections(
    dedent`
      /**
       * What is asserted here, and why the suite is shaped this way.
       *
       * Every case drives the gateway through a transport that answers from a literal, so nothing
       * touches the network and nothing is timing-dependent except the two cases about timeouts. That
       * is the payoff of the transport being a function: a client whose failure paths can only be
       * reached by breaking a real connection is a client whose failure paths are untested.
       *
       * Two helpers below — \`valueOf\` and \`failureOf\` — are the only place this suite knows how
       * failures are reported. Everything after them is one rendering, so the result form and the
       * throwing form are asserted to behave identically rather than being tested twice by hand.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.build, n.describe, ...(shape.results ? [] : [n.error])],
      types: [
        n.decoder,
        n.failure,
        n.reply,
        n.request,
        n.transport,
        ...(shape.results ? [n.outcome] : []),
      ],
    }),
    dedent`
      // A path prefix, because dropping one is the failure the URL cases exist for.
      const BASE = "https://api.test/v1";

      interface Widget {
        readonly id: string;
      }

      const decodeWidget: ${n.decoder}<Widget> = (body) => {
        const { id } = (body ?? {}) as Record<string, unknown>;
        return typeof id === "string"
          ? { ok: true, value: { id } }
          : { ok: false, problems: ["id must be a string"] };
      };

      // For the replies that carry nothing: a 204, or a delete that answers with an empty body.
      const decodeNothing: ${n.decoder}<undefined> = (body) =>
        body === undefined
          ? { ok: true, value: undefined }
          : { ok: false, problems: ["expected no body"] };

      /** A gateway whose transport answers with one reply, and the requests it was given. */
      function build(reply: Partial<${n.reply}> = {}) {
        const sent: ${n.request}[] = [];

        const gateway = ${n.build}({
          baseUrl: BASE,
          headers: { "x-key": "placeholder" },
          transport: (request) => {
            sent.push(request);
            return Promise.resolve({
              status: 200,
              statusText: "OK",
              headers: {},
              body: '{"id":"w1"}',
              ...reply,
            });
          },
        });

        return { gateway, sent };
      }

      function withTransport(transport: ${n.transport}) {
        return ${n.build}({ baseUrl: BASE, transport });
      }
    `,
    shape.results
      ? dedent`
          /** The value a call produced, failing the test rather than the type check if it did not. */
          async function valueOf<T>(work: Promise<${n.outcome}<T>>): Promise<T> {
            const outcome = await work;

            if (outcome.ok === false) {
              throw new Error(\`Expected a value, got a \${outcome.error.kind} failure.\`);
            }

            return outcome.value;
          }

          async function failureOf(
            work: Promise<${n.outcome}<unknown>>,
          ): Promise<${n.failure} | undefined> {
            const outcome = await work;
            return outcome.ok === true ? undefined : outcome.error;
          }
        `
      : dedent`
          /**
           * A pass-through in this rendering.
           *
           * It exists so that every case below is written once and reads the same whether failures are
           * returned or thrown.
           */
          async function valueOf<T>(work: Promise<T>): Promise<T> {
            return work;
          }

          async function failureOf(work: Promise<unknown>): Promise<${n.failure} | undefined> {
            try {
              await work;
              return undefined;
            } catch (error) {
              if (error instanceof ${n.error}) return error.failure;
              throw error;
            }
          }
        `,
    dedent`
      /**
       * The failure a call reported, narrowed to the kind the case is about.
       *
       * \`expect\` cannot narrow a union, so without this every assertion on a payload would be written
       * as a conditional expression — and a case that stopped reaching its failure would keep passing.
       */
      async function failureOfKind<K extends ${n.failure}["kind"]>(
        kind: K,
        work: Promise<${shape.results ? `${n.outcome}<unknown>` : "unknown"}>,
      ): Promise<Extract<${n.failure}, { readonly kind: K }>> {
        const failure = await failureOf(work);

        if (failure === undefined) throw new Error(\`Expected a \${kind} failure; the call succeeded.\`);
        if (failure.kind !== kind) throw new Error(\`Expected \${kind}, got \${failure.kind}.\`);

        return failure as Extract<${n.failure}, { readonly kind: K }>;
      }
    `,
    dedent`
      describe("url", () => {
        it("joins a path under the base's own path", () => {
          // Without the trailing slash this gateway adds, \`new URL\` would resolve this to
          // "https://api.test/widgets" and every request would miss the version prefix.
          expect(build().gateway.url("widgets")).toBe("https://api.test/v1/widgets");
        });

        it("resolves a path written with a leading slash the same way", () => {
          expect(build().gateway.url("/widgets")).toBe("https://api.test/v1/widgets");
        });

        it("encodes the query it was given and drops what was not supplied", () => {
          expect(
            build().gateway.url("widgets", { status: "open", cursor: undefined, limit: 25 }),
          ).toBe("https://api.test/v1/widgets?status=open&limit=25");
        });
      });
    `,
    dedent`
      describe("${n.build}", () => {
        it("returns the decoded body", async () => {
          expect((await valueOf(build().gateway.get("widgets/w1", decodeWidget))).id).toBe("w1");
        });
      ${indentBy(requestCases(shape), 2)}

        it("treats an empty body as no body rather than as malformed JSON", async () => {
          // \`JSON.parse("")\` throws, so without this a successful 204 would be reported as a broken
          // response.
          const { gateway } = build({ status: 204, statusText: "No Content", body: "" });
          expect(await valueOf(gateway.delete("widgets/w1", decodeNothing))).toBe(undefined);
        });
      });
    `,
    dedent`
      describe("failures", () => {
      ${indentBy(failureCases(shape), 2)}
      });
    `,
    dedent`
      describe("${n.describe}", () => {
        it("turns a failure into one sentence, without a caller reaching into it", () => {
          expect(${n.describe}({ kind: "invalid", problems: ["id must be a string"] })).toBe(
            "The response was not what was expected: id must be a string.",
          );
        });
      });
    `,
  );
}

/** The cases about what reached the transport. */
function requestCases(shape: Shape): string {
  return joinLines(
    "",
    dedent`
      it("sends a body as JSON and lets one call override a default header", async () => {
        const { gateway, sent } = build();
        await valueOf(
          gateway.post("widgets", { name: "second" }, decodeWidget, {
            headers: { "x-key": "per-call" },
          }),
        );

        const request = sent[0];

        expect(sent).toHaveLength(1);
        expect(request?.method).toBe("POST");
        expect(request?.url).toBe("https://api.test/v1/widgets");
        expect(request?.body).toBe('{"name":"second"}');
        // The content type is set because there is a body, and the gateway's own "x-key" is beaten by
        // the call's — which is the precedence a per-call override has to have to be worth having.
        expect(request?.headers).toEqual({
          "content-type": "application/json",
          "x-key": "per-call",
        });
      });

      it("sends no body, and no content type, for a request that has none", async () => {
        const { gateway, sent } = build();
        await valueOf(gateway.get("widgets", decodeWidget));

        expect(sent[0]?.body).toBe(undefined);
        expect(sent[0]?.headers).toEqual({ "x-key": "placeholder" });
      });
    `,
    when(
      shape.results,
      dedent`

        it("carries the status alongside a decoded value", async () => {
          // 201 rather than 200 is the whole reason the status survives a successful call.
          const { gateway } = build({ status: 201, statusText: "Created" });
          const outcome = await gateway.post("widgets", { name: "first" }, decodeWidget);

          expect(outcome.ok === true ? outcome.status : 0).toBe(201);
        });
      `,
    ),
  );
}

/** One case per failure kind. */
function failureCases(shape: Shape): string {
  return sections(
    dedent`
      it("reports an unsuccessful status with what the service actually said", async () => {
        const { gateway } = build({
          status: 503,
          statusText: "Service Unavailable",
          body: "upstream is busy",
        });

        const failure = await failureOfKind("status", gateway.get("widgets", decodeWidget));

        expect(failure.status).toBe(503);
        // The body is kept because a 5xx from a proxy explains itself there and nowhere else.
        expect(failure.body).toBe("upstream is busy");
      });
    `,
    dedent`
      it("reports a body that is not JSON, keeping the text that was not", async () => {
        // What a proxy or a load balancer answers with, which is never the JSON the service promised.
        const { gateway } = build({ body: "<html>504 Gateway Timeout</html>" });

        const failure = await failureOfKind("malformed", gateway.get("widgets", decodeWidget));

        expect(failure.body).toBe("<html>504 Gateway Timeout</html>");
      });
    `,
    dedent`
      it("reports a body the decoder rejected, with every problem it found", async () => {
        const { gateway } = build({ body: '{"id":42}' });

        const failure = await failureOfKind("invalid", gateway.get("widgets", decodeWidget));

        expect(failure.problems).toEqual(["id must be a string"]);
      });
    `,
    dedent`
      it("reports a request that never reached the service", async () => {
        const gateway = withTransport(() => Promise.reject(new Error("socket hang up")));

        const failure = await failureOfKind("transport", gateway.get("widgets", decodeWidget));

        expect(String(failure.cause)).toBe("Error: socket hang up");
      });
    `,
    when(
      shape.cancellable,
      sections(
        dedent`
          it("bounds a call whose transport ignores the signal", async () => {
            // Never settles: an open socket that has gone quiet. The signal is delivered and nothing
            // acts on it, so only the race can end this call — and a gateway that merely passed the
            // signal along would hang here forever.
            const gateway = withTransport(() => new Promise<${shape.names.reply}>(() => {}));

            const failure = await failureOfKind(
              "timeout",
              gateway.get("widgets", decodeWidget, { timeoutMs: 5 }),
            );

            expect(failure.timeoutMs).toBe(5);
          });
        `,
        dedent`
          it("blames the timeout when a cooperative transport aborts because of it", async () => {
            // What \`fetch\` does: the signal fires and the request rejects. The rejection reason says
            // "aborted" and nothing about why, so the gateway has to remember that it was the one who
            // aborted — otherwise this is reported as a transport failure and retried as one.
            const gateway = withTransport(
              (_request, signal) =>
                new Promise<${shape.names.reply}>((_resolve, reject) => {
                  signal?.addEventListener(
                    "abort",
                    () => {
                      reject(new Error("aborted"));
                    },
                    { once: true },
                  );
                }),
            );

            const failure = await failureOfKind(
              "timeout",
              gateway.get("widgets", decodeWidget, { timeoutMs: 5 }),
            );

            expect(failure.timeoutMs).toBe(5);
          });
        `,
        dedent`
          it("keeps a caller's cancellation distinct from a timeout", async () => {
            const controller = new AbortController();
            const gateway = withTransport(() => new Promise<${shape.names.reply}>(() => {}));
            const pending = gateway.get("widgets", decodeWidget, { signal: controller.signal });

            controller.abort(new Error("navigated away"));

            const failure = await failureOfKind("cancelled", pending);

            // The reason survives, so a log line can say what the caller was doing instead.
            expect(String(failure.reason)).toBe("Error: navigated away");
          });
        `,
      ),
    ),
    when(
      !shape.results,
      dedent`
        it("raises ${shape.names.error}, so one \`instanceof\` covers every kind", async () => {
          const { gateway } = build({ status: 500, statusText: "Internal Server Error", body: "" });

          await expect(gateway.get("widgets", decodeWidget)).rejects.toBeInstanceOf(
            ${shape.names.error},
          );
        });
      `,
    ),
  );
}
