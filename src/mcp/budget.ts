/**
 * How large a response is, in the unit that decides whether a caller receives all of it.
 *
 * The failure this exists to prevent is the worst one the product has. A host that truncates an oversized
 * tool result hands the model most of a file with no marker where it stopped; the model cannot tell, and
 * compiles it. Every other failure mode here is loud — a refusal states a rule, a verification failure
 * names itself a defect — and this one is silent and looks like success.
 *
 * So the budget is a property of the response, checked against a documented ceiling (plan.md: typical
 * comfortably under 10,000 tokens, against the ~25,000 point at which common hosts truncate).
 */

/**
 * Characters per token, deliberately pessimistic.
 *
 * Real tokenizers land around 3.5–4 characters per token on prose and 3–3.5 on dense TypeScript, and
 * worse on JSON, where the punctuation and escaping of a serialised bundle produce short tokens. Three is
 * below all of those, so this over-counts.
 *
 * Over-counting is the only safe direction. The number decides whether a ceiling is respected, and a
 * generous estimate would let a response through that a host then truncates — trading a loud test failure
 * for a silent corruption at a caller. An exact count would mean depending on one vendor's tokenizer,
 * which pins a permanent behaviour of this repository to a third party's table and would still be wrong
 * for every other host.
 */
const CHARS_PER_TOKEN = 3;

/** Conservative token count for a rendered response. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The point at which common agent hosts truncate a tool result (plan.md Constraints).
 *
 * A hard ceiling rather than a target: a response above this is not merely large, it arrives incomplete.
 */
export const TRUNCATION_TOKENS = 25_000;

/**
 * What a response is budgeted to stay under (plan.md Performance Goals).
 *
 * Well below the truncation point on purpose. A tool result does not arrive alone — it lands in a context
 * already holding the conversation, the caller's own files, and the results of earlier calls — so the
 * margin is what the rest of the session spends.
 */
export const BUDGET_TOKENS = 10_000;

/**
 * Whether a whole tool result is past the point where a host would cut it.
 *
 * The *whole* result rather than its text half, which is the distinction T085 left open. Summarising the
 * text bounds what lands in the transcript and keeps every byte in `structuredContent`, and that is the
 * right trade for a rendering — nothing is lost, because the data is still complete. It does not bound
 * the response, and `structuredContent` has no second place to keep what would not fit.
 *
 * Serialised rather than summed over the files: what a host counts is the payload, and the escaping and
 * punctuation of a JSON bundle are a real fraction of it.
 */
export function exceedsTruncation(response: unknown): boolean {
  return estimateTokens(JSON.stringify(response)) > TRUNCATION_TOKENS;
}
